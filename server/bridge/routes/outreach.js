const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getTransporter } = require('../utils/mailer');
const config = require('../utils/config');

const anthropic = new Anthropic();
const { wrapWithCTA, wrapInTemplate } = require('../utils/emailTemplates');

const GOOGLE_PLACES_API_KEY = config.apis.googleMapsKey;
const DAILY_SEND_LIMIT = config.outreach.dailySendLimit;

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

// Helper: extract shared prospect scraping logic
async function scrapeSingleQuery(industry, city, state, country, maxResults) {
  const query = `${industry} in ${city}${state ? ', ' + state : ''}${country ? ', ' + country : ''}`;

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
    throw new Error('Google Places API error: ' + (await placesResp.text()));
  }

  return await placesResp.json();
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

    const placesData = await scrapeSingleQuery(industry, city, country, null, maxResults);
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
          } catch (err) {
            console.error('[outreach] Email discovery failed:', err.message);
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

// POST /blast — scrape → generate → send in one call
router.post('/blast', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { industry, city, state, maxResults = 20 } = req.body;

    if (!industry || !city) {
      return res.status(400).json({ error: 'industry and city are required' });
    }

    // ===== STEP 1: SCRAPE =====
    console.log(`[blast] Scraping ${industry} in ${city}, ${state || 'US'}`);
    const placesData = await scrapeSingleQuery(industry, city, state, 'US', maxResults);
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

      let email = null;
      if (website) {
        const emailRegexes = [
          /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi,
          /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.(?:com|net|org|io|co|biz|info|us|ca|uk))\b/gi,
        ];
        const excludePatterns = /\.(png|jpg|jpeg|gif|svg|css|js|woff|ico)$/i;

        const pagesToCheck = [website];
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
          } catch (err) {
            console.error('[outreach] Email discovery failed:', err.message);
          }
        }
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      try {
        db.prepare(`
          INSERT INTO prospects (id, business_name, phone, email, website, address, industry, city, state, country, rating, review_count, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'US', ?, ?, 'scraped', ?, ?)
        `).run(id, name, phone, email, website, address, industry, city, state || null, rating, reviewCount, now, now);
      } catch (err) {
        if (!err.message.includes('UNIQUE')) {
          console.error('[blast] Insert prospect error:', err.message);
        }
        continue;
      }

      prospects.push({ id, business_name: name, phone, email, website, address, rating, review_count: reviewCount, industry, city, state });
    }

    console.log(`[blast] Scraped ${prospects.length}, ${withEmails} with emails`);

    // ===== STEP 2: CREATE CAMPAIGN =====
    const campaignName = `${industry} in ${city} - ${new Date().toLocaleDateString()}`;
    const campaignId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO campaigns (id, name, industry, city, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(campaignId, campaignName, industry, city, now, now);

    // Link prospects to campaign
    const linkStmt = db.prepare(
      'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)'
    );

    const linkMany = db.transaction((ids) => {
      for (const pid of ids) {
        linkStmt.run(randomUUID(), campaignId, pid, now);
      }
    });
    linkMany(prospects.map(p => p.id));

    console.log(`[blast] Campaign created: ${campaignId}`);

    // ===== STEP 3: GENERATE EMAILS =====
    const { generateColdEmail, pickVariant } = require('../utils/emailGenerator');
    const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const emails = [];
    let generateFailed = 0;

    for (let idx = 0; idx < prospects.length; idx++) {
      const prospect = prospects[idx];
      if (!prospect.email) continue;

      try {
        const emailGen = await generateColdEmail(prospect);
        const variant = pickVariant(idx);
        const subject = variant === 'A' ? emailGen.subject_a : emailGen.subject_b;
        const emailId = randomUUID();

        db.prepare(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, subject_a, subject_b, variant, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `).run(emailId, campaignId, prospect.id, prospect.email, senderEmail, subject, emailGen.body, emailGen.subject_a, emailGen.subject_b, variant, now, now);

        emails.push({ id: emailId, prospect_id: prospect.id, to_email: prospect.email, subject, variant, status: 'draft' });
      } catch (err) {
        console.error(`[blast] Generate failed for ${prospect.business_name}:`, err.message);
        generateFailed++;
      }
    }

    console.log(`[blast] Generated ${emails.length} emails`);

    // ===== STEP 4: SEND EMAILS =====
    const today = new Date().toISOString().split('T')[0];
    const sentToday = db.prepare(
      "SELECT COUNT(*) as count FROM emails_sent WHERE status = 'sent' AND sent_at >= ?"
    ).get(today + 'T00:00:00.000Z').count;

    const remaining = DAILY_SEND_LIMIT - sentToday;
    if (remaining <= 0) {
      return res.status(429).json({
        error: `Daily send limit reached (${DAILY_SEND_LIMIT}/day)`,
        campaign_id: campaignId,
        scraped: prospects.length,
        generated: emails.length,
        sent: 0,
        failed: 0,
        prospects: prospects.slice(0, 5)
      });
    }

    const transport = getTransporter();
    const { verifyEmail } = require('../utils/emailVerifier');
    let sent = 0;
    let failed = 0;
    let skippedInvalid = 0;
    const sanitizeHeader = s => String(s || '').replace(/[\r\n]/g, '');

    for (let i = 0; i < emails.length && i < remaining; i++) {
      const email = db.prepare('SELECT * FROM emails_sent WHERE id = ?').get(emails[i].id);
      if (!email) continue;

      // Verify email before sending to prevent bounces
      try {
        const verification = await verifyEmail(email.to_email);
        if (!verification.valid) {
          console.log(`[blast] Skipping invalid email ${email.to_email}: ${verification.reason} (${verification.method})`);
          db.prepare("UPDATE emails_sent SET status = 'invalid', error = ?, updated_at = ? WHERE id = ?")
            .run(`verification_failed: ${verification.reason}`, new Date().toISOString(), email.id);
          db.prepare("UPDATE prospects SET status = 'invalid_email', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), email.prospect_id);
          skippedInvalid++;
          continue;
        }
      } catch (verifyErr) {
        // Verification failed — send anyway rather than block
        console.warn(`[blast] Email verification error for ${email.to_email}: ${verifyErr.message} — sending anyway`);
      }

      try {
        await transport.sendMail({
          from: `"${config.outreach.senderName}" <${sanitizeHeader(email.from_email)}>`,
          to: sanitizeHeader(email.to_email),
          subject: sanitizeHeader(email.subject),
          text: email.body,
          html: wrapWithCTA(
            email.body.replace(/Book a 10-min demo:.*$/m, '').trim(),
            'Book a 10-min Demo',
            config.outreach.bookingLink,
            '',
            { unsubscribeEmail: email.from_email }
          ),
          headers: {
            'List-Unsubscribe': `<mailto:${sanitizeHeader(email.from_email)}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        const sentNow = new Date().toISOString();
        db.prepare(
          "UPDATE emails_sent SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?"
        ).run(sentNow, sentNow, email.id);

        // Schedule Day 3 follow-up
        try {
          const { enqueueJob } = require('../utils/jobQueue');
          enqueueJob(db, 'noreply_followup', {
            prospect_id: email.prospect_id,
            to_email: email.to_email,
            from_email: email.from_email,
            original_subject: email.subject,
            campaign_id: campaignId,
            booking_link: config.outreach.bookingLink,
            sender_name: config.outreach.senderName,
            day: 3,
          }, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
        } catch (err) {
          console.error('[blast] Failed to schedule follow-up:', err.message);
        }

        sent++;

        // 2-second delay between sends
        if (i < emails.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (err) {
        console.error(`[blast] Failed to send to ${email.to_email}:`, err.message);

        const isBounce = err.responseCode >= 550 || err.message.includes('rejected') ||
          err.message.includes('not exist') || err.message.includes('undeliverable');

        const status = isBounce ? 'bounced' : 'failed';
        const nowTime = new Date().toISOString();

        db.prepare(
          "UPDATE emails_sent SET status = ?, error = ?, updated_at = ? WHERE id = ?"
        ).run(status, err.message, nowTime, email.id);

        if (isBounce) {
          db.prepare("UPDATE prospects SET status = 'bounced', updated_at = ? WHERE id = ?").run(nowTime, email.prospect_id);
        }

        failed++;
      }
    }

    // Mark campaign as active
    db.prepare(
      "UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), campaignId);

    console.log(`[blast] Campaign ${campaignId}: sent=${sent} failed=${failed} invalid=${skippedInvalid}`);

    res.json({
      campaign_id: campaignId,
      scraped: prospects.length,
      generated: emails.length,
      emailed: emails.length,
      sent,
      failed,
      skipped_invalid: skippedInvalid,
      remaining: remaining - sent,
      prospects: prospects.slice(0, 5)
    });
  } catch (err) {
    console.error('[blast] error:', err);
    // Include campaign_id if it was created before the error
    const errorResponse = {
      error: 'Failed to execute blast',
      details: err.message
    };
    res.status(500).json(errorResponse);
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

    const { generateColdEmail, pickVariant } = require('../utils/emailGenerator');
    const emails = [];
    const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER;

    for (let idx = 0; idx < prospects.length; idx++) {
      const prospect = prospects[idx];
      if (!prospect.email) continue;

      // Skip bounced/unsubscribed prospects
      if (['bounced', 'unsubscribed'].includes(prospect.status)) continue;

      try {
        const emailGen = await generateColdEmail(prospect);
        const variant = pickVariant(idx);
        const subject = variant === 'A' ? emailGen.subject_a : emailGen.subject_b;

        const emailId = randomUUID();
        const now = new Date().toISOString();

        db.prepare(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, subject_a, subject_b, variant, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `).run(emailId, campaignId, prospect.id, prospect.email, senderEmail, subject, emailGen.body, emailGen.subject_a, emailGen.subject_b, variant, now, now);

        emails.push({ id: emailId, prospect_id: prospect.id, to_email: prospect.email, subject, body: emailGen.body, variant, status: 'draft' });
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
    const { verifyEmail } = require('../utils/emailVerifier');
    let sent = 0;
    let failed = 0;
    let skippedInvalid = 0;

    const sanitizeHeader = s => String(s || '').replace(/[\r\n]/g, '');
    const { generateTrackingPixel, wrapLinksWithTracking } = require('../utils/emailTracking');

    // Batch concurrent email sending for improved throughput
    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 100;

    // Helper function to verify and send a single email
    const sendEmailAsync = async (email) => {
      try {
        // Verify email before sending
        try {
          const verification = await verifyEmail(email.to_email);
          if (!verification.valid) {
            console.log(`[outreach] Skipping invalid email ${email.to_email}: ${verification.reason}`);
            db.prepare("UPDATE emails_sent SET status = 'invalid', error = ?, updated_at = ? WHERE id = ?")
              .run(`verification_failed: ${verification.reason}`, new Date().toISOString(), email.id);
            db.prepare("UPDATE prospects SET status = 'invalid_email', updated_at = ? WHERE id = ?")
              .run(new Date().toISOString(), email.prospect_id);
            return { status: 'invalid', email_id: email.id, prospect_id: email.prospect_id };
          }
        } catch (verifyErr) {
          console.warn(`[outreach] Verification error for ${email.to_email}: ${verifyErr.message} — sending anyway`);
        }

        // Generate HTML with tracking
        let htmlContent = wrapWithCTA(
          email.body.replace(/Book a 10-min demo:.*$/m, '').trim(),
          'Book a 10-min Demo',
          config.outreach.bookingLink,
          '',
          { unsubscribeEmail: email.from_email }
        );
        // Add link tracking and open pixel
        htmlContent = wrapLinksWithTracking(htmlContent, email.id);
        htmlContent += generateTrackingPixel(email.id);

        await transport.sendMail({
          from: `"${config.outreach.senderName}" <${sanitizeHeader(email.from_email)}>`,
          to: sanitizeHeader(email.to_email),
          subject: sanitizeHeader(email.subject),
          text: email.body,
          html: htmlContent,
          headers: {
            'List-Unsubscribe': `<mailto:${sanitizeHeader(email.from_email)}?subject=unsubscribe>`,
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
            booking_link: config.outreach.bookingLink,
            sender_name: config.outreach.senderName,
            day: 3,
          }, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
        } catch (err) {
          console.error('[outreach] Failed to schedule follow-up:', err.message);
        }

        return { status: 'sent', email_id: email.id, prospect_id: email.prospect_id };
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

        return { status: status, email_id: email.id, prospect_id: email.prospect_id, error: err.message };
      }
    };

    // Process emails in batches with concurrent sending
    for (let i = 0; i < drafts.length; i += BATCH_SIZE) {
      const batch = drafts.slice(i, i + BATCH_SIZE);
      console.log(`[outreach] Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} emails)`);

      // Send all emails in batch concurrently
      const results = await Promise.allSettled(
        batch.map(email => sendEmailAsync(email))
      );

      // Process results and track successes/failures
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const outcome = result.value;
          if (outcome.status === 'sent') {
            sent++;
          } else if (outcome.status === 'invalid') {
            skippedInvalid++;
          } else if (outcome.status === 'bounced' || outcome.status === 'failed') {
            failed++;
          }
        } else {
          // Promise rejected (shouldn't happen due to try-catch in sendEmailAsync)
          console.error('[outreach] Unexpected error in batch processing:', result.reason);
          failed++;
        }
      }

      // Rate limit pause between batches to avoid SMTP rate limits
      if (i + BATCH_SIZE < drafts.length) {
        console.log(`[outreach] Batch complete. Pausing ${BATCH_DELAY_MS}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Update campaign status
    db.prepare(
      "UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), campaignId);

    console.log(`[outreach] Campaign ${campaignId}: sent=${sent} failed=${failed} invalid=${skippedInvalid}`);
    res.json({ sent, failed, skipped_invalid: skippedInvalid, remaining: remaining - sent });
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
      model: config.ai.model,
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
    } catch (err) {
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

    const BOOKING_LINK = config.outreach.bookingLink;
    const SENDER_NAME = config.outreach.senderName;

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

// GET /campaign/:campaignId/ab-results
router.get('/campaign/:campaignId/ab-results', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    // Get all emails in campaign grouped by variant
    const variantA = db.prepare(`
      SELECT
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
      FROM emails_sent
      WHERE campaign_id = ? AND status IN ('sent', 'bounced', 'failed') AND variant = 'A'
    `).get(campaignId);

    const variantB = db.prepare(`
      SELECT
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
      FROM emails_sent
      WHERE campaign_id = ? AND status IN ('sent', 'bounced', 'failed') AND variant = 'B'
    `).get(campaignId);

    // Get top subject line for each variant
    const topSubjectA = db.prepare(`
      SELECT subject, COUNT(*) as count FROM emails_sent
      WHERE campaign_id = ? AND variant = 'A'
      GROUP BY subject
      ORDER BY count DESC
      LIMIT 1
    `).get(campaignId);

    const topSubjectB = db.prepare(`
      SELECT subject, COUNT(*) as count FROM emails_sent
      WHERE campaign_id = ? AND variant = 'B'
      GROUP BY subject
      ORDER BY count DESC
      LIMIT 1
    `).get(campaignId);

    // Calculate rates
    const aOpenRate = variantA.sent > 0 ? variantA.opened / variantA.sent : 0;
    const aClickRate = variantA.sent > 0 ? variantA.clicked / variantA.sent : 0;
    const bOpenRate = variantB.sent > 0 ? variantB.opened / variantB.sent : 0;
    const bClickRate = variantB.sent > 0 ? variantB.clicked / variantB.sent : 0;

    // Determine winner (highest open rate)
    const winner = aOpenRate >= bOpenRate ? 'A' : 'B';

    res.json({
      variant_a: {
        sent: variantA.sent || 0,
        opened: variantA.opened || 0,
        clicked: variantA.clicked || 0,
        open_rate: Math.round(aOpenRate * 100) / 100,
        click_rate: Math.round(aClickRate * 100) / 100,
        top_subject: topSubjectA?.subject || 'N/A'
      },
      variant_b: {
        sent: variantB.sent || 0,
        opened: variantB.opened || 0,
        clicked: variantB.clicked || 0,
        open_rate: Math.round(bOpenRate * 100) / 100,
        click_rate: Math.round(bClickRate * 100) / 100,
        top_subject: topSubjectB?.subject || 'N/A'
      },
      winner
    });
  } catch (err) {
    console.error('[outreach] ab-results error:', err);
    res.status(500).json({ error: 'Failed to get A/B results' });
  }
});

// POST /auto-classify — automatically classify all unclassified replies
// Call this on a cron (every 5 min) or after IMAP fetch
// Delegates to shared utility to avoid duplication and HTTP overhead
router.post('/auto-classify', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { autoClassifyReplies } = require('../utils/autoClassify');
    const result = await autoClassifyReplies(db);
    res.json({ classified: result.classified, results: result.results, message: result.message });
  } catch (err) {
    console.error('[outreach] auto-classify error:', err);
    res.status(500).json({ error: 'Failed to auto-classify replies' });
  }
});

module.exports = router;
