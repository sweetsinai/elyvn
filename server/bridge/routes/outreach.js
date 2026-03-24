const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

const anthropic = new Anthropic();

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DAILY_SEND_LIMIT = 30;

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
      const phone = place.nationalPhoneNumber || place.internationalPhoneNumber || null;
      const website = place.websiteUri || null;
      const address = place.formattedAddress || null;
      const rating = place.rating || null;
      const reviewCount = place.userRatingCount || 0;

      // Try to find email from website
      let email = null;
      if (website) {
        try {
          const siteResp = await fetch(website, {
            signal: AbortSignal.timeout(5000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ELYVN/1.0)' }
          });
          if (siteResp.ok) {
            const html = await siteResp.text();
            const emailMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
            if (emailMatch) {
              email = emailMatch[1];
              withEmails++;
            }
          }
        } catch (_) {
          // Timeout or fetch error, skip email extraction
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
    const senderName = process.env.OUTREACH_SENDER_NAME || 'ELYVN';
    const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER;

    for (const prospect of prospects) {
      if (!prospect.email) continue;

      try {
        const resp = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Write a cold email to ${prospect.business_name} (${prospect.industry || campaign.industry} business in ${prospect.city || campaign.city}).
They have ${prospect.review_count || 'some'} reviews and a ${prospect.rating || 'good'} rating.

The email is from ${senderName}, an AI-powered phone answering service that handles calls, books appointments, and qualifies leads 24/7.

Rules:
- Subject line first, then blank line, then body
- Keep it under 150 words
- Personalize to their business
- One clear CTA
- Professional but warm tone
- No false claims

Format:
Subject: [subject line]

[email body]`
          }]
        });

        const content = resp.content[0]?.text || '';
        const subjectMatch = content.match(/^Subject:\s*(.+)/m);
        const subject = subjectMatch ? subjectMatch[1].trim() : `AI receptionist for ${prospect.business_name}`;
        const body = content.replace(/^Subject:\s*.+\n\n?/m, '').trim();

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
      return res.status(429).json({ error: 'Daily send limit reached (30/day)', sent_today: sentToday });
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
          from: sanitizeHeader(email.from_email),
          to: sanitizeHeader(email.to_email),
          subject: sanitizeHeader(email.subject),
          text: email.body,
          html: email.body.replace(/\n/g, '<br>')
        });

        db.prepare(
          "UPDATE emails_sent SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), new Date().toISOString(), email.id);

        sent++;
      } catch (err) {
        console.error(`[outreach] Failed to send to ${email.to_email}:`, err.message);

        db.prepare(
          "UPDATE emails_sent SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
        ).run(err.message, new Date().toISOString(), email.id);

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

    db.prepare(
      'UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?'
    ).run(statusMap[classification] || 'engaged', new Date().toISOString(), email.prospect_id);

    // Auto-respond for certain classifications
    if (classification === 'UNSUBSCRIBE') {
      suggestedResponse = 'Thank you for letting us know. You have been removed from our list. We wish you all the best.';
    }

    if (suggestedResponse && email.to_email && (classification === 'INTERESTED' || classification === 'UNSUBSCRIBE')) {
      try {
        const transport = getTransporter();
        await transport.sendMail({
          from: email.from_email,
          to: email.to_email,
          subject: `Re: ${email.subject}`,
          text: suggestedResponse
        });
        console.log(`[outreach] Auto-responded to ${email.to_email} (${classification})`);
      } catch (err) {
        console.error('[outreach] Auto-response failed:', err.message);
      }
    }

    res.json({ classification, suggested_response: suggestedResponse });
  } catch (err) {
    console.error('[outreach] classify error:', err);
    res.status(500).json({ error: 'Failed to classify reply' });
  }
});

module.exports = router;
