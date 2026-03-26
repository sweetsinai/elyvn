const express = require('express');
const { SCRAPER_RETRY_DELAY_MS } = require('../config/timing');
const router = express.Router();
const { randomUUID } = require('crypto');
const { getTransporter } = require('../utils/mailer');
const config = require('../utils/config');

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

    // Wrap campaign creation and prospect linking in transaction for all-or-nothing semantics
    const createCampaign = db.transaction((campaignId, campaignName, industryVal, cityVal, timestamp) => {
      // Insert campaign
      db.prepare(`
        INSERT INTO campaigns (id, name, industry, city, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `).run(campaignId, campaignName, industryVal, cityVal, timestamp, timestamp);

      // Link prospects to campaign
      const linkStmt = db.prepare(
        'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)'
      );
      for (const prospect of prospects) {
        linkStmt.run(randomUUID(), campaignId, prospect.id, timestamp);
      }
    });

    createCampaign(campaignId, campaignName, industry || null, city || null, now);

    console.log(`[blast] Created campaign ${campaignId}`);

    // ===== STEP 3: GENERATE EMAILS =====
    const { generateColdEmail, pickVariant } = require('../utils/emailGenerator');
    const emails = [];
    const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
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
    const { wrapWithCTA } = require('../utils/emailTemplates');

    // Batch-load all emails to avoid N+1 queries
    const emailIds = emails.slice(0, remaining).map(e => e.id);
    const placeholders = emailIds.map(() => '?').join(',');
    const allEmails = emailIds.length > 0
      ? db.prepare(`SELECT * FROM emails_sent WHERE id IN (${placeholders})`).all(...emailIds)
      : [];
    const emailsMap = new Map(allEmails.map(e => [e.id, e]));

    for (let i = 0; i < emails.length && i < remaining; i++) {
      const email = emailsMap.get(emails[i].id);
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
          await new Promise(resolve => setTimeout(resolve, SCRAPER_RETRY_DELAY_MS));
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
      prospects: prospects.slice(0, 5)
    });
  } catch (err) {
    console.error('[outreach] blast error:', err);
    res.status(500).json({ error: 'Failed to blast prospects' });
  }
});

module.exports = router;
