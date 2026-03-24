const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const anthropic = new Anthropic();
const { wrapWithCTA, wrapInTemplate } = require('../utils/emailTemplates');

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DAILY_SEND_LIMIT = parseInt(process.env.EMAIL_DAILY_LIMIT || '300', 10);

/**
 * Normalize a phone number to E.164 format.
 * Handles US numbers: (555) 123-4567 → +15551234567
 */
function normalizePhoneE164(raw, defaultCountryCode = '1') {
  if (!raw) return null;
  // Strip everything except digits and leading +
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  }
  // If 10 digits, assume US/CA and prepend country code
  if (digits.length === 10) {
    digits = defaultCountryCode + digits;
  }
  // If 11 digits starting with 1, it's already US format
  if (digits.length === 11 && digits.startsWith('1')) {
    // good
  }
  // Validate: must be 10-15 digits
  if (digits.length < 10 || digits.length > 15) {
    return null; // Invalid
  }
  return '+' + digits;
}

// SMTP transporter (lazy init)
let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }
  return transporter;
}

// POST /scrape
router.post('/scrape', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { industry, city, country, maxResults = 20 } = req.body;

    if (!industry || !city) {
      return res.status(400).json({ error: 'industry and city are required' });
    }

    const query = `${industry} in ${city}${country ? ', ' + country : ''}`;
    console.log(`[outreach] Scraping: ${query}`);

    // Google Places Text Search
    const placesResp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress,places.rating,places.userRatingCount'
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: Math.min(parseInt(maxResults), 20)
      })
    });

    if (!placesResp.ok) {
      const errText = await placesResp.text();
      console.error('[outreach] Places API error:', errText);
      return res.status(502).json({ error: 'Google Places API error' });
    }

    const placesData = await placesResp.json();
    const places = placesData.places || [];

    const prospects = [];
    let withEmails = 0;

    for (const place of places) {
      const name = place.displayName?.text || '';
      const rawPhone = place.nationalPhoneNumber || place.internationalPhoneNumber || null;
      const phone = normalizePhoneE164(rawPhone);
      const website = place.websiteUri || null;
      const address = place.formattedAddress || null;
      const rating = place.rating || null;
      const reviewCount = place.userRatingCount || 0;

      // Try to find email from website — check homepage AND /contact page
      let email = null;
      if (website) {
        const emailRegexes = [
          /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi,
          /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.(?:com|net|org|io|co|biz|info|us|ca|uk))\b/gi,
        ];
        const excludePatterns = /\.(png|jpg|jpeg|gif|svg|css|js|woff|ico)$/i;

        const pagesToCheck = [website];
        // Add common contact page URLs
        const baseUrl = website.replace(/\/+$/, '');
        pagesToCheck.push(`${baseUrl}/contact`, `${baseUrl}/contact-us`, `${baseUrl}/about`);

        for (const pageUrl of pagesToCheck) {
          if (email) break;
          try {
            const siteResp = await fetch(pageUrl, {
              signal: AbortSignal.timeout(5000),
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
              redirect: 'follow',
            });
            if (siteResp.ok) {
              const html = await siteResp.text();
              for (const regex of emailRegexes) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(html)) !== null) {
                  const candidate = match[1].toLowerCase();
                  // Filter out image/asset emails and noreply addresses
                  if (!excludePatterns.test(candidate) &&
                      !candidate.includes('noreply') &&
                      !candidate.includes('no-reply') &&
                      !candidate.includes('example.com') &&
                      !candidate.includes('sentry.io') &&
                      !candidate.includes('wixpress.com') &&
                      candidate.length < 80) {
                    email = candidate;
                    withEmails++;
                    break;
                  }
                }
                if (email) break;
              }
            }
          } catch (_) {
            // Timeout or fetch error, try next page
          }
        }
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      try {
        db.prepare(`
          INSERT INTO prospects (id, business_name, phone, email, website, address, industry, city, country, rating, review_count, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scraped', ?, ?)
        `).run(id, name, phone, email, website, address, industry, city, country || null, rating, reviewCount, now, now);
      } catch (err) {
        // Duplicate or constraint error — skip
        if (!err.message.includes('UNIQUE')) {
          console.error('[outreach] Insert prospect error:', err.message);
        }
        continue;
      }

      prospects.push({ id, business_name: name, phone, email, website, address, rating, review_count: reviewCount });
    }

    console.log(`[outreach] Scraped ${prospects.length} prospects, ${withEmails} with emails`);
    res.json({ scraped: prospects.length, withEmails, prospects });
  } catch (err) {
    console.error('[outreach] scrape error:', err);
    res.status(500).json({ error: 'Failed to scrape prospects' });
  }
});

// POST /campaign
router.post('/campaign', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { name, industry, city, prospectIds } = req.body;

    if (!name || !prospectIds?.length) {
      return res.status(400).json({ error: 'name and prospectIds are required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO campaigns (id, name, industry, city, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(id, name, industry || null, city || null, now, now);

    // Link prospects to campaign
    const linkStmt = db.prepare(
      'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)'
    );

    const linkMany = db.transaction((ids) => {
      for (const pid of ids) {
        linkStmt.run(randomUUID(), id, pid, now);
      }
    });
    linkMany(prospectIds);

    res.status(201).json({ campaign: { id, name, industry, city, status: 'draft', prospect_count: prospectIds.length } });
  } catch (err) {
    console.error('[outreach] campaign create error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// POST /campaign/:campaignId/generate
router.post('/campaign/:campaignId/generate', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Get all prospects in campaign
    const prospects = db.prepare(`
      SELECT p.* FROM prospects p
      JOIN campaign_prospects cp ON cp.prospect_id = p.id
      WHERE cp.campaign_id = ?
    `).all(campaignId);

    if (!prospects.length) {
      return res.status(400).json({ error: 'No prospects in campaign' });
    }

    const emails = [];
    const senderName = process.env.OUTREACH_SENDER_NAME || 'Sohan';
    const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const bookingLink = process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo';
    const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

    for (const prospect of prospects) {
      if (!prospect.email) continue;

      // Skip bounced/unsubscribed prospects
      if (['bounced', 'unsubscribed'].includes(prospect.status)) continue;

      try {
        const resp = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Write a cold email to ${prospect.business_name} (${prospect.industry || campaign.industry} business in ${prospect.city || campaign.city}).
They have ${prospect.review_count || 'some'} reviews and a ${prospect.rating || 'good'} rating.

The email is from ${senderName} at ELYVN, an AI-powered phone answering service that handles calls, books appointments, and qualifies leads 24/7.

Rules:
- Subject line first, then blank line, then body
- Keep it under 150 words
- Personalize to their business
- MUST end with this exact CTA: "Book a 10-min demo: ${bookingLink}"
- Professional but warm tone, written from ${senderName}
- No false claims
- Sign off: ${senderName}, ELYVN

Format:
Subject: [subject line]

[email body]`
          }]
        });

        const content = resp.content[0]?.text || '';
        const subjectMatch = content.match(/^Subject:\s*(.+)/m);
        const subject = subjectMatch ? subjectMatch[1].trim() : `AI receptionist for ${prospect.business_name}`;
        let body = content.replace(/^Subject:\s*.+\n\n?/m, '').trim();

        // Safety net: ensure booking link is always in the body
        if (!body.includes(bookingLink)) {
          body += `\n\nBook a 10-min demo: ${bookingLink}`;
        }

        const emailId = randomUUID();
        const now = new Date().toISOString();

        db.prepare(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `).run(emailId, campaignId, prospect.id, prospect.email, senderEmail, subject, body, now, now);

        emails.push({ id: emailId, prospect_id: prospect.id, to_email: prospect.email, subject, body, status: 'draft' });
      } catch (err) {
        console.error(`[outreach] Failed to generate email for ${prospect.business_name}:`, err.message);
      }
    }

    res.json({ generated: emails.length, emails });
  } catch (err) {
    console.error('[outreach] generate error:', err);
    res.status(500).json({ error: 'Failed to generate emails' });
  }
});

// PUT /campaign/:campaignId/email/:emailId
router.put('/campaign/:campaignId/email/:emailId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { campaignId, emailId } = req.params;
    const { subject, body } = req.body;

    const result = db.prepare(`
      UPDATE emails_sent SET subject = COALESCE(?, subject), body = COALESCE(?, body), updated_at = ?
      WHERE id = ? AND campaign_id = ?
    `).run(subject || null, body || null, new Date().toISOString(), emailId, campaignId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const email = db.prepare('SELECT * FROM emails_sent WHERE id = ?').get(emailId);
    res.json({ email });
  } catch (err) {
    console.error('[outreach] edit email error:', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// POST /campaign/:campaignId/send
router.post('/campaign/:campaignId/send', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    // Check daily send limit
    const today = new Date().toISOString().split('T')[0];
    const sentToday = db.prepare(
      "SELECT COUNT(*) as count FROM emails_sent WHERE status = 'sent' AND sent_at >= ?"
    ).get(today + 'T00:00:00.000Z').count;

    const remaining = DAILY_SEND_LIMIT - sentToday;
    if (remaining <= 0) {
      return res.status(429).json({ error: `Daily send limit reached (${DAILY_SEND_LIMIT}/day)`, sent_today: sentToday });
    }

    // Get draft emails for this campaign
    const drafts = db.prepare(
      "SELECT * FROM emails_sent WHERE campaign_id = ? AND status = 'draft' LIMIT ?"
    ).all(campaignId, remaining);

    if (!drafts.length) {
      return res.status(400).json({ error: 'No draft emails to send' });
    }

    const transport = getTransporter();
    let sent = 0;
    let failed = 0;

    const sanitizeHeader = s => String(s || '').replace(/[\r\n]/g, '');

    for (const email of drafts) {
      try {
        await transport.sendMail({
          from: `"${process.env.OUTREACH_SENDER_NAME || 'Sohan'}" <${sanitizeHeader(email.from_email)}>`,
          to: sanitizeHeader(email.to_email),
          subject: sanitizeHeader(email.subject),
          text: email.body,
          html: wrapWithCTA(
            email.body.replace(/Book a 10-min demo:.*$/m, '').trim(),
            'Book a 10-min Demo',
            process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo',
            '',
            { unsubscribeEmail: email.from_email }
          ),
          headers: {
            'List-Unsubscribe': `<mailto:${email.from_email}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        const sentNow = new Date().toISOString();
        db.prepare(
          "UPDATE emails_sent SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?"
        ).run(sentNow, sentNow, email.id);

        // Schedule Day 3 no-reply follow-up
        try {
          const { enqueueJob } = require('../utils/jobQueue');
          enqueueJob(db, 'noreply_followup', {
            prospect_id: email.prospect_id,
            to_email: email.to_email,
            from_email: email.from_email,
            original_subject: email.subject,
            campaign_id: campaignId,
            booking_link: process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo',
            sender_name: process.env.OUTREACH_SENDER_NAME || 'Sohan',
            day: 3,
          }, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
        } catch (err) {
          console.error('[outreach] Failed to schedule follow-up:', err.message);
        }

        sent++;

        // 2-second delay between sends to avoid spam triggers
        if (sent < drafts.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (err) {
        console.error(`[outreach] Failed to send to ${email.to_email}:`, err.message);

        // Detect bounces
        const isBounce = err.responseCode >= 550 || err.message.includes('rejected') ||
          err.message.includes('not exist') || err.message.includes('undeliverable');

        const status = isBounce ? 'bounced' : 'failed';
        const now = new Date().toISOString();

        db.prepare(
          "UPDATE emails_sent SET status = ?, error = ?, updated_at = ? WHERE id = ?"
        ).run(status, err.message, now, email.id);

        // Mark bounced prospects so we never email them again
        if (isBounce) {
          db.prepare("UPDATE prospects SET status = 'bounced', updated_at = ? WHERE id = ?").run(now, email.prospect_id);
        }

        failed++;
      }
    }

    // Update campaign status
    db.prepare(
      "UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), campaignId);

    console.log(`[outreach] Campaign ${campaignId}: sent=${sent} failed=${failed}`);
    res.json({ sent, failed, remaining: remaining - sent });
  } catch (err) {
    console.error('[outreach] send error:', err);
    res.status(500).json({ error: 'Failed to send emails' });
  }
});

// GET /replies
router.get('/replies', (req, res) => {
  try {
    const db = req.app.locals.db;

    const replies = db.prepare(`
      SELECT es.*, p.business_name, p.phone, p.website, c.name as campaign_name
      FROM emails_sent es
      JOIN prospects p ON p.id = es.prospect_id
      LEFT JOIN campaigns c ON c.id = es.campaign_id
      WHERE es.reply_text IS NOT NULL
      ORDER BY es.reply_at DESC
    `).all();

    res.json({ replies });
  } catch (err) {
    console.error('[outreach] replies error:', err);
    res.status(500).json({ error: 'Failed to fetch replies' });
  }
});

// POST /replies/:emailId/classify
router.post('/replies/:emailId/classify', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { emailId } = req.params;

    const email = db.prepare('SELECT * FROM emails_sent WHERE id = ?').get(emailId);
    if (!email || !email.reply_text) {
      return res.status(404).json({ error: 'Email or reply not found' });
    }

    // Classify with Claude
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Classify this email reply into exactly one category. Reply with JSON: {"classification": "INTERESTED" | "QUESTION" | "NOT_INTERESTED" | "UNSUBSCRIBE", "suggested_response": "brief response text"}

Original email subject: ${email.subject}
Original email: ${email.body}

Reply: ${email.reply_text}`
      }]
    });

    let classification = 'QUESTION';
    let suggestedResponse = '';

    try {
      const parsed = JSON.parse(resp.content[0]?.text || '{}');
      classification = parsed.classification || 'QUESTION';
      suggestedResponse = parsed.suggested_response || '';
    } catch (_) {
      const text = resp.content[0]?.text || '';
      if (text.includes('INTERESTED')) classification = 'INTERESTED';
      else if (text.includes('NOT_INTERESTED')) classification = 'NOT_INTERESTED';
      else if (text.includes('UNSUBSCRIBE')) classification = 'UNSUBSCRIBE';
    }

    // Update email record
    db.prepare(
      'UPDATE emails_sent SET reply_classification = ?, updated_at = ? WHERE id = ?'
    ).run(classification, new Date().toISOString(), emailId);

    // Update prospect status based on classification
    const statusMap = {
      'INTERESTED': 'interested',
      'QUESTION': 'engaged',
      'NOT_INTERESTED': 'not_interested',
      'UNSUBSCRIBE': 'unsubscribed'
    };

    const now = new Date().toISOString();
    const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(email.prospect_id);

    db.prepare(
      'UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?'
    ).run(statusMap[classification] || 'engaged', now, email.prospect_id);

    const BOOKING_LINK = process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo';
    const SENDER_NAME = process.env.OUTREACH_SENDER_NAME || 'Sohan';

    // === INTERESTED: Full conversion sequence ===
    if (classification === 'INTERESTED') {
      // 0. Create a lead record so this prospect enters the lead pipeline
      try {
        const client = db.prepare('SELECT * FROM clients WHERE is_active = 1 LIMIT 1').get();
        if (client && prospect) {
          const existingLead = db.prepare(
            'SELECT id FROM leads WHERE client_id = ? AND (email = ? OR (phone IS NOT NULL AND phone = ?))'
          ).get(client.id, email.to_email, prospect.phone || '');
          if (!existingLead) {
            const leadId = randomUUID();
            db.prepare(`
              INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, prospect_id, last_contact, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'outreach', 7, 'qualified', ?, ?, ?, ?)
            `).run(leadId, client.id, prospect.business_name || '', prospect.phone || null, email.to_email, prospect.id, now, now, now);
            console.log(`[outreach] Lead ${leadId} created from INTERESTED prospect ${prospect.id}`);
          } else {
            // Update existing lead score
            db.prepare("UPDATE leads SET score = MAX(score, 7), stage = 'qualified', updated_at = ? WHERE id = ?").run(now, existingLead.id);
          }
        }
      } catch (err) {
        console.error('[outreach] Lead creation from INTERESTED failed:', err.message);
      }

      // 1. Send email with booking link immediately
      const interestedReply = `Hi${prospect?.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nGreat to hear from you! I'd love to show you how ELYVN can help you catch every call and book more appointments.\n\nHere's my calendar — pick any time that works for you:\n${BOOKING_LINK}\n\nIf you'd prefer, you can also call us directly and our AI will walk you through a live demo.\n\nLooking forward to chatting!\n\n${SENDER_NAME}\nELYVN`;

      try {
        const transport = getTransporter();
        await transport.sendMail({
          from: email.from_email,
          to: email.to_email,
          subject: `Re: ${email.subject}`,
          text: interestedReply,
        });
        console.log(`[outreach] INTERESTED auto-reply sent to ${email.to_email} with booking link`);

        db.prepare(
          'UPDATE emails_sent SET auto_response_sent = 1, updated_at = ? WHERE id = ?'
        ).run(now, emailId);
      } catch (err) {
        console.error('[outreach] INTERESTED auto-reply failed:', err.message);
      }

      // 2. Send SMS with booking link if prospect has phone
      if (prospect?.phone) {
        try {
          const { sendSMS } = require('../utils/sms');
          const smsText = `Hi! This is ${SENDER_NAME} from ELYVN. Thanks for your interest! Book a quick 10-min demo here: ${BOOKING_LINK}`;
          await sendSMS(db, prospect.phone, smsText, null);
          console.log(`[outreach] INTERESTED SMS sent to ${prospect.phone}`);
        } catch (err) {
          console.error('[outreach] INTERESTED SMS failed:', err.message);
        }
      }

      // 3. Notify owner via Telegram
      try {
        const { sendTelegramNotification } = require('../utils/telegram');
        const alertMsg = `🔥 *HOT LEAD* from cold outreach!\n\n*${prospect?.business_name || 'Unknown'}*\n📧 ${email.to_email}\n📱 ${prospect?.phone || 'No phone'}\n\nThey replied INTERESTED to: "${email.subject}"\n\nBooking link sent automatically. Reply: "${email.reply_text?.substring(0, 200) || ''}"`;
        await sendTelegramNotification(alertMsg);
      } catch (err) {
        console.error('[outreach] Telegram notification failed:', err.message);
      }

      // 4. Schedule follow-up email in 24h if no booking
      try {
        const { enqueueJob } = require('../utils/jobQueue');
        enqueueJob(db, 'interested_followup_email', {
          prospect_id: email.prospect_id,
          email_id: emailId,
          to_email: email.to_email,
          from_email: email.from_email,
          subject: email.subject,
          booking_link: BOOKING_LINK,
          sender_name: SENDER_NAME,
        }, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
        console.log(`[outreach] Scheduled 24h follow-up for ${email.to_email}`);
      } catch (err) {
        console.error('[outreach] Failed to schedule follow-up:', err.message);
      }

      suggestedResponse = interestedReply;
    }

    // === QUESTION: Send helpful response with booking link ===
    if (classification === 'QUESTION' && suggestedResponse) {
      // Append booking link to questions too
      suggestedResponse += `\n\nIf you'd like to see it in action, here's a quick demo link: ${BOOKING_LINK}`;

      try {
        const transport = getTransporter();
        await transport.sendMail({
          from: email.from_email,
          to: email.to_email,
          subject: `Re: ${email.subject}`,
          text: suggestedResponse,
        });
        console.log(`[outreach] QUESTION auto-reply sent to ${email.to_email}`);
      } catch (err) {
        console.error('[outreach] QUESTION auto-reply failed:', err.message);
      }
    }

    // === UNSUBSCRIBE: Confirm removal ===
    if (classification === 'UNSUBSCRIBE') {
      suggestedResponse = 'Thank you for letting us know. You have been removed from our list. We wish you all the best.';

      try {
        const transport = getTransporter();
        await transport.sendMail({
          from: email.from_email,
          to: email.to_email,
          subject: `Re: ${email.subject}`,
          text: suggestedResponse,
        });
        console.log(`[outreach] UNSUBSCRIBE confirmed to ${email.to_email}`);
      } catch (err) {
        console.error('[outreach] UNSUBSCRIBE auto-reply failed:', err.message);
      }
    }

    res.json({ classification, suggested_response: suggestedResponse });
  } catch (err) {
    console.error('[outreach] classify error:', err);
    res.status(500).json({ error: 'Failed to classify reply' });
  }
});

// POST /auto-classify — automatically classify all unclassified replies
// Call this on a cron (every 5 min) or after IMAP fetch
router.post('/auto-classify', async (req, res) => {
  try {
    const db = req.app.locals.db;

    const unclassified = db.prepare(`
      SELECT * FROM emails_sent
      WHERE reply_text IS NOT NULL AND reply_classification IS NULL
      ORDER BY reply_at ASC
      LIMIT 20
    `).all();

    if (!unclassified.length) {
      return res.json({ classified: 0, message: 'No unclassified replies' });
    }

    const results = [];
    for (const email of unclassified) {
      try {
        // Re-use the classify endpoint logic inline
        const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
        const resp = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Classify this email reply into exactly one category. Reply with JSON only: {"classification": "INTERESTED" | "QUESTION" | "NOT_INTERESTED" | "UNSUBSCRIBE", "suggested_response": "brief response text"}

Original email subject: ${email.subject}
Original email: ${email.body}

Reply: ${email.reply_text}`
          }]
        });

        let classification = 'QUESTION';
        let suggestedResponse = '';

        try {
          const parsed = JSON.parse(resp.content[0]?.text || '{}');
          classification = parsed.classification || 'QUESTION';
          suggestedResponse = parsed.suggested_response || '';
        } catch (_) {
          const text = resp.content[0]?.text || '';
          if (text.includes('INTERESTED')) classification = 'INTERESTED';
          else if (text.includes('NOT_INTERESTED')) classification = 'NOT_INTERESTED';
          else if (text.includes('UNSUBSCRIBE')) classification = 'UNSUBSCRIBE';
        }

        const now = new Date().toISOString();

        // Update classification
        db.prepare(
          'UPDATE emails_sent SET reply_classification = ?, updated_at = ? WHERE id = ?'
        ).run(classification, now, email.id);

        // Update prospect status
        const statusMap = {
          'INTERESTED': 'interested',
          'QUESTION': 'engaged',
          'NOT_INTERESTED': 'not_interested',
          'UNSUBSCRIBE': 'unsubscribed'
        };
        db.prepare(
          'UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?'
        ).run(statusMap[classification] || 'engaged', now, email.prospect_id);

        const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(email.prospect_id);
        const BOOKING_LINK = process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo';
        const SENDER_NAME = process.env.OUTREACH_SENDER_NAME || 'Sohan';

        // Auto-respond based on classification
        if (classification === 'INTERESTED' && !email.auto_response_sent) {
          // Create lead from interested prospect
          try {
            const client = db.prepare('SELECT * FROM clients WHERE is_active = 1 LIMIT 1').get();
            if (client && prospect) {
              const existingLead = db.prepare(
                'SELECT id FROM leads WHERE client_id = ? AND (email = ? OR (phone IS NOT NULL AND phone = ?))'
              ).get(client.id, email.to_email, prospect.phone || '');
              if (!existingLead) {
                const leadId = randomUUID();
                db.prepare(`
                  INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, prospect_id, last_contact, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'outreach', 7, 'qualified', ?, ?, ?, ?)
                `).run(leadId, client.id, prospect.business_name || '', prospect.phone || null, email.to_email, prospect.id, now, now, now);
                console.log(`[auto-classify] Lead created from INTERESTED prospect ${prospect.id}`);
              } else {
                db.prepare("UPDATE leads SET score = MAX(score, 7), stage = 'qualified', updated_at = ? WHERE id = ?").run(now, existingLead.id);
              }
            }
          } catch (err) {
            console.error('[auto-classify] Lead creation failed:', err.message);
          }

          const interestedReply = `Hi${prospect?.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nGreat to hear from you! I'd love to show you how ELYVN can help.\n\nPick any time: ${BOOKING_LINK}\n\nLooking forward to chatting!\n\n${SENDER_NAME}\nELYVN`;
          try {
            const transport = getTransporter();
            await transport.sendMail({
              from: email.from_email,
              to: email.to_email,
              subject: `Re: ${email.subject}`,
              text: interestedReply,
            });
            db.prepare('UPDATE emails_sent SET auto_response_sent = 1, updated_at = ? WHERE id = ?').run(now, email.id);

            // SMS if phone available
            if (prospect?.phone) {
              try {
                const { sendSMS } = require('../utils/sms');
                await sendSMS(prospect.phone, `Hi! This is ${SENDER_NAME} from ELYVN. Thanks for your interest! Book a demo: ${BOOKING_LINK}`, null);
              } catch (_) {}
            }

            // Telegram alert
            try {
              const { sendTelegramNotification } = require('../utils/telegram');
              await sendTelegramNotification(`🔥 *HOT LEAD* (auto-classified)\n*${prospect?.business_name || 'Unknown'}* — ${email.to_email}\nReplied INTERESTED. Auto-response sent.`);
            } catch (_) {}

            // 24h follow-up job
            try {
              const { enqueueJob } = require('../utils/jobQueue');
              enqueueJob(db, 'interested_followup_email', {
                prospect_id: email.prospect_id,
                email_id: email.id,
                to_email: email.to_email,
                from_email: email.from_email,
                subject: email.subject,
                booking_link: BOOKING_LINK,
                sender_name: SENDER_NAME,
              }, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
            } catch (_) {}
          } catch (err) {
            console.error('[auto-classify] INTERESTED auto-reply failed:', err.message);
          }
        }

        if (classification === 'UNSUBSCRIBE') {
          try {
            const transport = getTransporter();
            await transport.sendMail({
              from: email.from_email,
              to: email.to_email,
              subject: `Re: ${email.subject}`,
              text: 'You have been removed from our list. We wish you all the best.',
            });
          } catch (_) {}
        }

        results.push({ id: email.id, to: email.to_email, classification });
        console.log(`[auto-classify] ${email.to_email} → ${classification}`);

        // Small delay between API calls
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`[auto-classify] Failed for ${email.id}:`, err.message);
        results.push({ id: email.id, error: err.message });
      }
    }

    res.json({ classified: results.filter(r => !r.error).length, results });
  } catch (err) {
    console.error('[outreach] auto-classify error:', err);
    res.status(500).json({ error: 'Failed to auto-classify replies' });
  }
});

module.exports = router;
