const express = require('express');
const { SCRAPER_RETRY_DELAY_MS, FETCH_TIMEOUT } = require('../config/timing');
const router = express.Router();
const { randomUUID } = require('crypto');
const { getTransporter } = require('../utils/mailer');
const config = require('../utils/config');
const { normalizePhone } = require('../utils/phone');
const { logger } = require('../utils/logger');
const { logDataMutation } = require('../utils/auditLog');
const { AppError } = require('../utils/AppError');
const { isAsync } = require('../utils/dbAdapter');
const { validateBody } = require('../middleware/validateRequest');
const { ScrapeSchema, BlastSchema } = require('../utils/schemas/scrape');

const GOOGLE_PLACES_API_KEY = config.apis.googleMapsKey;
const DAILY_SEND_LIMIT = config.outreach.dailySendLimit;

// SSRF protection: validate URLs before fetching website content
function isSafeURL(urlString) {
  try {
    const parsed = new URL(urlString);
    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    // Block internal/private IPs and localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
    if (hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    // Block private IP ranges
    if (/^10\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^169\.254\./.test(hostname)) return false;
    // Block metadata endpoints (cloud providers)
    if (hostname === '169.254.169.254') return false;
    if (hostname === 'metadata.google.internal') return false;
    return true;
  } catch {
    return false;
  }
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
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!placesResp.ok) {
    throw new AppError('INTERNAL_ERROR', 'Google Places API error: ' + (await placesResp.text()), 500);
  }

  return await placesResp.json();
}

// POST /scrape
router.post('/scrape', validateBody(ScrapeSchema), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { industry, city, country, maxResults = 20 } = req.body;

    const query = `${industry} in ${city}${country ? ', ' + country : ''}`;
    logger.info(`[outreach] Scraping: ${query}`);

    const placesData = await scrapeSingleQuery(industry, city, country, null, maxResults);
    const places = placesData.places || [];

    const prospects = [];
    let withEmails = 0;

    for (const place of places) {
      const name = place.displayName?.text || '';
      const rawPhone = place.nationalPhoneNumber || place.internationalPhoneNumber || null;
      const phone = normalizePhone(rawPhone);
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

        // SSRF protection: only fetch safe external URLs
        if (!isSafeURL(website)) {
          logger.warn(`[scrape] Blocked unsafe URL: ${website}`);
        } else {
        const pagesToCheck = [website];
        // Add common contact page URLs
        const baseUrl = website.replace(/\/+$/, '');
        pagesToCheck.push(`${baseUrl}/contact`, `${baseUrl}/contact-us`, `${baseUrl}/about`);

        for (const pageUrl of pagesToCheck) {
          if (email) break;
          if (!isSafeURL(pageUrl)) continue;
          try {
            const siteResp = await fetch(pageUrl, {
              signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
            logger.error('[outreach] Email discovery failed:', err.message);
          }
        }
        } // end SSRF-safe check
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      try {
        await db.query(`
          INSERT INTO prospects (id, business_name, phone, email, website, address, industry, city, country, rating, review_count, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scraped', ?, ?)
        `, [id, name, phone, email, website, address, industry, city, country || null, rating, reviewCount, now, now], 'run');
      } catch (err) {
        // Duplicate or constraint error — skip
        if (!err.message.includes('UNIQUE')) {
          logger.error('[outreach] Insert prospect error:', err.message);
        }
        continue;
      }

      try { logDataMutation(db, { action: 'client_created', table: 'prospects', recordId: id, newValues: { business_name: name, phone, email, industry, city } }); } catch (_) {}

      prospects.push({ id, business_name: name, phone, email, website, address, rating, review_count: reviewCount });
    }

    logger.info(`[outreach] Scraped ${prospects.length} prospects, ${withEmails} with emails`);
    res.json({ scraped: prospects.length, withEmails, prospects });
  } catch (err) {
    logger.error('[outreach] scrape error:', err);
    res.status(500).json({ error: 'Failed to scrape prospects' });
  }
});

// POST /blast — scrape → generate → send in one call
router.post('/blast', validateBody(ScrapeSchema), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { industry, city, state, maxResults = 20 } = req.body;

    // ===== STEP 1: SCRAPE =====
    logger.info(`[blast] Scraping ${industry} in ${city}, ${state || 'US'}`);
    const placesData = await scrapeSingleQuery(industry, city, state, 'US', maxResults);
    const places = placesData.places || [];

    const prospects = [];
    let withEmails = 0;

    for (const place of places) {
      const name = place.displayName?.text || '';
      const rawPhone = place.nationalPhoneNumber || place.internationalPhoneNumber || null;
      const phone = normalizePhone(rawPhone);
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

        // SSRF protection: only fetch safe external URLs
        if (!isSafeURL(website)) {
          logger.warn(`[scrape] Blocked unsafe URL: ${website}`);
        } else {
        const pagesToCheck = [website];
        const baseUrl = website.replace(/\/+$/, '');
        pagesToCheck.push(`${baseUrl}/contact`, `${baseUrl}/contact-us`, `${baseUrl}/about`);

        for (const pageUrl of pagesToCheck) {
          if (email) break;
          if (!isSafeURL(pageUrl)) continue;
          try {
            const siteResp = await fetch(pageUrl, {
              signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
            logger.error('[outreach] Email discovery failed:', err.message);
          }
        }
        } // end SSRF-safe check
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      try {
        await db.query(`
          INSERT INTO prospects (id, business_name, phone, email, website, address, industry, city, state, country, rating, review_count, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'US', ?, ?, 'scraped', ?, ?)
        `, [id, name, phone, email, website, address, industry, city, state || null, rating, reviewCount, now, now], 'run');
      } catch (err) {
        if (!err.message.includes('UNIQUE')) {
          logger.error('[blast] Insert prospect error:', err.message);
        }
        continue;
      }

      try { logDataMutation(db, { action: 'client_created', table: 'prospects', recordId: id, newValues: { business_name: name, phone, email, industry, city, state } }); } catch (_) {}

      prospects.push({ id, business_name: name, phone, email, website, address, rating, review_count: reviewCount, industry, city, state });
    }

    logger.info(`[blast] Scraped ${prospects.length}, ${withEmails} with emails`);

    // ===== STEP 2: CREATE CAMPAIGN =====
    const campaignName = `${industry} in ${city} - ${new Date().toLocaleDateString()}`;
    const campaignId = randomUUID();
    const now = new Date().toISOString();

    if (isAsync(db)) {
      // Postgres: async transaction
      await db.query('BEGIN', [], 'run');
      try {
        await db.query(`
          INSERT INTO campaigns (id, name, industry, city, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'draft', ?, ?)
        `, [campaignId, campaignName, industry || null, city || null, now, now], 'run');

        for (const prospect of prospects) {
          await db.query(
            'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)',
            [randomUUID(), campaignId, prospect.id, now], 'run'
          );
        }
        await db.query('COMMIT', [], 'run');
      } catch (txErr) {
        await db.query('ROLLBACK', [], 'run');
        throw txErr;
      }
    } else {
      // SQLite: sync transaction
      const createCampaign = db.transaction((cId, cName, industryVal, cityVal, timestamp) => {
        db.prepare(`
          INSERT INTO campaigns (id, name, industry, city, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'draft', ?, ?)
        `).run(cId, cName, industryVal, cityVal, timestamp, timestamp);

        const linkStmt = db.prepare(
          'INSERT INTO campaign_prospects (id, campaign_id, prospect_id, created_at) VALUES (?, ?, ?, ?)'
        );
        for (const prospect of prospects) {
          linkStmt.run(randomUUID(), cId, prospect.id, timestamp);
        }
      });
      createCampaign(campaignId, campaignName, industry || null, city || null, now);
    }

    logger.info(`[blast] Created campaign ${campaignId}`);

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

        await db.query(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, subject_a, subject_b, variant, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `, [emailId, campaignId, prospect.id, prospect.email, senderEmail, subject, emailGen.body, emailGen.subject_a, emailGen.subject_b, variant, now, now], 'run');

        emails.push({ id: emailId, prospect_id: prospect.id, to_email: prospect.email, subject, variant, status: 'draft' });
      } catch (err) {
        logger.error(`[blast] Generate failed for ${prospect.business_name}:`, err.message);
        generateFailed++;
      }
    }

    logger.info(`[blast] Generated ${emails.length} emails`);

    // ===== STEP 4: SEND EMAILS =====
    const today = new Date().toISOString().split('T')[0];
    const sentTodayResult = await db.query(
      "SELECT COUNT(*) as count FROM emails_sent WHERE status = 'sent' AND sent_at >= ?",
      [today + 'T00:00:00.000Z'],
      'get'
    );
    const sentToday = sentTodayResult.count;

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
      ? await db.query(`SELECT * FROM emails_sent WHERE id IN (${placeholders})`, emailIds, 'all')
      : [];
    const emailsMap = new Map(allEmails.map(e => [e.id, e]));

    for (let i = 0; i < emails.length && i < remaining; i++) {
      const email = emailsMap.get(emails[i].id);
      if (!email) continue;

      // Verify email before sending to prevent bounces
      try {
        const verification = await verifyEmail(email.to_email);
        if (!verification.valid) {
          logger.info(`[blast] Skipping invalid email ${email.to_email}: ${verification.reason} (${verification.method})`);
          await db.query("UPDATE emails_sent SET status = 'invalid', error = ?, updated_at = ? WHERE id = ?",
            [`verification_failed: ${verification.reason}`, new Date().toISOString(), email.id], 'run');
          await db.query("UPDATE prospects SET status = 'invalid_email', updated_at = ? WHERE id = ?",
            [new Date().toISOString(), email.prospect_id], 'run');
          skippedInvalid++;
          continue;
        }
      } catch (verifyErr) {
        // Verification failed — send anyway rather than block
        logger.warn(`[blast] Email verification error for ${email.to_email}: ${verifyErr.message} — sending anyway`);
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
        await db.query(
          "UPDATE emails_sent SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?",
          [sentNow, sentNow, email.id],
          'run'
        );

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
          logger.error('[blast] Failed to schedule follow-up:', err.message);
        }

        sent++;

        // 2-second delay between sends
        if (i < emails.length - 1) {
          await new Promise(resolve => setTimeout(resolve, SCRAPER_RETRY_DELAY_MS));
        }
      } catch (err) {
        logger.error(`[blast] Failed to send to ${email.to_email}:`, err.message);

        const isBounce = err.responseCode >= 550 || err.message.includes('rejected') ||
          err.message.includes('not exist') || err.message.includes('undeliverable');

        const status = isBounce ? 'bounced' : 'failed';
        const nowTime = new Date().toISOString();

        await db.query(
          "UPDATE emails_sent SET status = ?, error = ?, updated_at = ? WHERE id = ?",
          [status, err.message, nowTime, email.id],
          'run'
        );

        if (isBounce) {
          await db.query("UPDATE prospects SET status = 'bounced', updated_at = ? WHERE id = ?", [nowTime, email.prospect_id], 'run');
        }

        failed++;
      }
    }

    // Mark campaign as active
    await db.query(
      "UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?",
      [new Date().toISOString(), campaignId],
      'run'
    );

    logger.info(`[blast] Campaign ${campaignId}: sent=${sent} failed=${failed} invalid=${skippedInvalid}`);

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
    logger.error('[outreach] blast error:', err);
    res.status(500).json({ error: 'Failed to blast prospects' });
  }
});

module.exports = router;
