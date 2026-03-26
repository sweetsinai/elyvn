const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const telegram = require('../utils/telegram');
const { triggerSpeedSequence } = require('../utils/speed-to-lead');
const { normalizePhone } = require('../utils/phone');
const { isValidUUID, isValidPhone, isValidEmail, sanitizeString } = require('../utils/validate');
const { logger } = require('../utils/logger');

// Speed-to-lead deduplication store: tracks recent speed-to-lead jobs by phone+email within 5 minutes
const speedToLeadStore = new Map();
const SPEED_TO_LEAD_DEDUP_WINDOW = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a speed-to-lead job was already created for this phone/email in the last 5 minutes.
 * Returns true if duplicate, false if new/allowed.
 */
function isDuplicateSpeedToLead(phone, email) {
  const key = `${phone}|${email}`;
  const now = Date.now();
  const entry = speedToLeadStore.get(key);

  if (!entry) {
    // New entry
    speedToLeadStore.set(key, now);
    return false;
  }

  if (now - entry > SPEED_TO_LEAD_DEDUP_WINDOW) {
    // Expired, update and allow
    speedToLeadStore.set(key, now);
    return false;
  }

  // Duplicate within window
  return true;
}

// Cleanup dedup store every 10 minutes
const dedupsCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of speedToLeadStore) {
    if (now - timestamp > SPEED_TO_LEAD_DEDUP_WINDOW * 2) {
      speedToLeadStore.delete(key);
    }
  }
}, 10 * 60 * 1000);

// Simple in-memory rate limiter for form submissions
const formRateLimitStore = new Map();
const FORM_RATE_LIMIT = 10; // max requests
const FORM_RATE_WINDOW = 60000; // per 60 seconds

function checkFormRateLimit(ip) {
  const now = Date.now();
  const entry = formRateLimitStore.get(ip);
  if (!entry || now - entry.start > FORM_RATE_WINDOW) {
    formRateLimitStore.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > FORM_RATE_LIMIT) return false;
  return true;
}

// Cleanup every 5 minutes
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of formRateLimitStore) {
    if (now - entry.start > FORM_RATE_WINDOW * 2) formRateLimitStore.delete(ip);
  }
}, 300000);

// Export cleanup function for tests
function cleanupFormTimers() {
  if (dedupsCleanupInterval) clearInterval(dedupsCleanupInterval);
  if (rateLimitCleanupInterval) clearInterval(rateLimitCleanupInterval);
}

function formRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkFormRateLimit(ip)) {
    logger.warn(`[forms] Rate limit exceeded for ${ip}`);
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }
  next();
}

// POST /webhooks/form (no clientId in URL — reads client_id from body)
router.post('/', formRateLimit, async (req, res) => {
  const body = req.body || {};
  const clientId = body.client_id || body.clientId;
  if (!clientId) {
    return res.status(400).json({ error: 'client_id required in body' });
  }
  if (!isValidUUID(clientId)) {
    return res.status(400).json({ error: 'invalid client_id format' });
  }
  req.params = { clientId };
  // Forward to the /:clientId handler below
  res.status(200).json({ status: 'received', message: 'Lead captured' });

  const db = req.app.locals.db;
  if (!db) return;

  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ? AND is_active = 1').get(clientId);
    if (!client) { logger.error(`[Form] Unknown client: ${clientId}`); return; }

    const name = body.name || body.first_name || body['your-name'] || body.fullName || body.full_name || null;
    const phone = normalizePhone(body.phone || body.Phone || body['your-phone'] || body.tel || body.mobile || null);
    const email = body.email || body.Email || body['your-email'] || null;

    // Validate phone if provided
    if (phone && !isValidPhone(phone)) {
      logger.warn(`[Form] Invalid phone format: ${phone}`);
      return;
    }

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      logger.warn(`[Form] Invalid email format: ${email}`);
      return;
    }
    const message = body.message || body.Message || body['your-message'] || body.body || body.inquiry || '';
    const service = body.service || body.Service || null;
    const source = body.utm_source || body.source || 'website_form';

    if (!phone) {
      if (email) {
        const leadId = randomUUID();
        db.prepare(`INSERT INTO leads (id, client_id, name, phone, source, score, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, 5, 'new', datetime('now'), datetime('now'), datetime('now'))`).run(leadId, clientId, name, source);
        if (client.telegram_chat_id) {
          // Escape form fields to prevent XSS in Telegram HTML
          const escapeHtml = (str) => (str || '').replace(/[&<>"]/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
          }[c]));
          telegram.sendMessage(client.telegram_chat_id,
            `📋 <b>New form submission (no phone)</b>\n\n` +
            (name ? `<b>Name:</b> ${escapeHtml(name)}\n` : '') + `<b>Email:</b> ${escapeHtml(email)}\n` +
            (message ? `<b>Message:</b> "${escapeHtml(message.substring(0, 200))}"\n` : '') +
            `\n⚠️ No phone — can't auto-call or text.`
          ).catch(() => {});
        }
      }
      return;
    }

    // Atomic upsert using INSERT ... ON CONFLICT (no race conditions)
    const leadId = randomUUID();
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, name, email, source, score, stage, last_contact, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 7, 'new', datetime('now'), datetime('now'))
      ON CONFLICT(client_id, phone) DO UPDATE SET
        name = COALESCE(excluded.name, leads.name),
        email = COALESCE(excluded.email, leads.email),
        source = COALESCE(excluded.source, leads.source),
        last_contact = datetime('now'),
        updated_at = datetime('now')
    `).run(leadId, clientId, phone, name || null, email || null, source);

    db.prepare(`INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'form', 'inbound', ?, 'received', datetime('now'), datetime('now'))`).run(randomUUID(), clientId, leadId, phone, message || `Form: ${service || 'General inquiry'}`);

    // Deduplication: only trigger speed-to-lead if not a duplicate within 5 minutes
    if (!isDuplicateSpeedToLead(phone, email)) {
      await triggerSpeedSequence(db, { leadId, clientId, phone, name, email, message, service, source: 'form', client });
    } else {
      logger.info(`[Form] Speed-to-lead deduplicated for ${phone}/${email}`);
    }

    try {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');
      const memory = getLeadMemory(db, phone, clientId);
      if (memory) {
        const decision = await think('form_submitted', { name, phone, email, message, service, source }, memory, db);
        await executeActions(db, decision.actions, memory);
      }
    } catch (brainErr) { logger.error('[Brain] Form error:', brainErr.message); }

    logger.info(`[Form] Processed: ${name || phone} → ${client.business_name}`);
  } catch (err) { logger.error('[Form] Error:', err.message); }
});

// POST /webhooks/form/:clientId
// Accepts form submissions from any source (WordPress, Typeform, Wix, Squarespace, custom HTML)
// Supports JSON and URL-encoded bodies
// Field aliases: Contact Form 7, Typeform, generic caps, standard
router.post('/:clientId', formRateLimit, async (req, res) => {
  // Always 200 immediately — form builders retry on failure
  res.status(200).json({ status: 'received', message: 'Lead captured' });

  const db = req.app.locals.db;
  if (!db) {
    logger.error('[Form] No database connection');
    return;
  }
  const clientId = req.params.clientId;

  // Validate clientId format
  if (!isValidUUID(clientId)) {
    logger.error(`[Form] Invalid clientId format: ${clientId}`);
    return;
  }

  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ? AND is_active = 1').get(clientId);
    if (!client) {
      logger.error(`[Form] Unknown or inactive client: ${clientId}`);
      return;
    }

    const body = req.body || {};

    // Normalize field names across form builder conventions
    const name = body.name || body.first_name || body['your-name'] || body.Name || body['full-name'] || body.fullName
      || (body.first_name && body.last_name ? `${body.first_name} ${body.last_name}` : null)
      || null;

    const phone = normalizePhone(
      body.phone || body.Phone || body['your-phone'] || body.tel
      || body.telephone || body.mobile || body.cell || body.phone_number || null
    );

    const email = body.email || body.Email || body['your-email']
      || body.email_address || body.emailAddress || null;

    // Validate phone if provided
    if (phone && !isValidPhone(phone)) {
      logger.warn(`[Form] Invalid phone format: ${phone}`);
      return;
    }

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      logger.warn(`[Form] Invalid email format: ${email}`);
      return;
    }

    const message = (body.message || body.Message || body['your-message']
      || body.comments || body.inquiry || body.details || body.notes || '').substring(0, 2000);

    const service = body.service || body.Service || body.service_type
      || body.serviceType || body['service-type'] || null;

    const source = body.utm_source || body.source || body.referrer || 'website_form';

    // No phone — create lead with email only + notify client
    if (!phone) {
      logger.info(`[Form] No phone in submission for ${clientId}`);
      if (email) {
        const leadId = randomUUID();
        db.prepare(`
          INSERT INTO leads (id, client_id, name, phone, source, score, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, 5, 'new', datetime('now'), datetime('now'), datetime('now'))
        `).run(leadId, clientId, name, source);

        if (client.telegram_chat_id) {
          // Escape form fields to prevent XSS in Telegram HTML
          const escapeHtml = (str) => (str || '').replace(/[&<>"]/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
          }[c]));
          telegram.sendMessage(
            client.telegram_chat_id,
            `📋 <b>New form submission (no phone)</b>\n\n` +
            (name ? `<b>Name:</b> ${escapeHtml(name)}\n` : '') +
            `<b>Email:</b> ${escapeHtml(email)}\n` +
            (message ? `<b>Message:</b> "${escapeHtml(message.substring(0, 200))}"\n` : '') +
            `\n⚠️ No phone — can't auto-call or text.`
          ).catch(() => {});
        }
      }
      return;
    }

    // Atomic upsert using INSERT ... ON CONFLICT (no race conditions)
    const leadId = randomUUID();
    db.prepare(`
      INSERT INTO leads (id, client_id, phone, name, email, source, score, stage, last_contact, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 7, 'new', datetime('now'), datetime('now'))
      ON CONFLICT(client_id, phone) DO UPDATE SET
        name = COALESCE(excluded.name, leads.name),
        email = COALESCE(excluded.email, leads.email),
        source = COALESCE(excluded.source, leads.source),
        last_contact = datetime('now'),
        updated_at = datetime('now')
    `).run(leadId, clientId, phone, name || null, email || null, source);

    // Log inbound message
    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'form', 'inbound', ?, 'received', datetime('now'), datetime('now'))
    `).run(randomUUID(), clientId, leadId, phone, message || `Form submission: ${service || 'General inquiry'}`);

    // Deduplication: only trigger speed-to-lead if not a duplicate within 5 minutes
    if (!isDuplicateSpeedToLead(phone, email)) {
      // Trigger triple-touch speed sequence
      await triggerSpeedSequence(db, {
        leadId, clientId, phone, name, email, message, service,
        source: 'form',
        client
      });
    } else {
      logger.info(`[Form] Speed-to-lead deduplicated for ${phone}/${email}`);
    }

    // Brain: form submission analysis
    try {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');
      const memory = getLeadMemory(db, phone, clientId);
      if (memory) {
        const decision = await think('form_submitted', {
          name, phone, email, message, service, source,
        }, memory, db);
        await executeActions(db, decision.actions, memory);
      }
    } catch (brainErr) {
      logger.error('[Brain] Form submission error:', brainErr.message);
    }

    logger.info(`[Form] Speed sequence triggered: ${name || phone} → ${client.business_name}`);
  } catch (err) {
    logger.error('[Form] Error processing submission:', err.message);
  }
});

module.exports = router;
module.exports.cleanupFormTimers = cleanupFormTimers;
