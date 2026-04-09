const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const telegram = require('../utils/telegram');
const { triggerSpeedSequence } = require('../utils/speed-to-lead');
const { normalizePhone } = require('../utils/phone');
const { isValidUUID } = require('../utils/validate');
const { logger } = require('../utils/logger');
const { validateEmail: validateEmailFormat, validatePhone: validatePhoneFormat, validateLength, LENGTH_LIMITS, sanitizeString: sanitizeInput } = require('../utils/inputValidation');
const { encrypt } = require('../utils/encryption');
const { validateBody, validateParams } = require('../middleware/validateRequest');
const { FormSubmissionSchema, FormParamsSchema } = require('../utils/schemas/form');
const { AppError } = require('../utils/AppError');
const timing = require('../config/timing');

// Speed-to-lead deduplication store: tracks recent speed-to-lead jobs by phone+email within 5 minutes
const speedToLeadStore = new Map();
const SPEED_TO_LEAD_DEDUP_WINDOW = timing.FORM_SPEED_TO_LEAD_DEDUP_WINDOW_MS;

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
const FORM_RATE_LIMIT = timing.FORM_RATE_LIMIT;
const FORM_RATE_WINDOW = timing.FORM_RATE_WINDOW_MS;

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
    return res.status(429).json({ success: false, error: 'Too many submissions. Please try again later.', code: 'RATE_LIMIT_EXCEEDED' });
  }
  next();
}

// Shared form processing logic
// Throws AppError for validation failures so route handlers can return 4xx responses.
async function processFormSubmission(db, body, clientId, req) {
  const client = await db.query('SELECT * FROM clients WHERE id = ? AND is_active = 1', [clientId], 'get');
  if (!client) {
    logger.error(`[Form] Unknown or inactive client: ${clientId}`);
    throw new AppError('CLIENT_NOT_FOUND', 'Unknown or inactive client', 404);
  }

  // Normalize field names across form builder conventions
  const rawName = body.name || body.first_name || body['your-name'] || body.Name || body['full-name'] || body.fullName
    || body.full_name
    || (body.first_name && body.last_name ? `${body.first_name} ${body.last_name}` : null)
    || null;

  const name = rawName ? sanitizeInput(rawName, LENGTH_LIMITS.name) : null;

  // Validate name length if provided (max 255 chars per LENGTH_LIMITS.name = 200; using that limit)
  if (name) {
    const nameValidation = validateLength(name, 'name', LENGTH_LIMITS.name);
    if (!nameValidation.valid) {
      logger.warn(`[Form] Name validation failed: ${nameValidation.error}`);
      throw new AppError('INVALID_NAME', nameValidation.error, 400);
    }
  }

  const phone = normalizePhone(
    body.phone || body.Phone || body['your-phone'] || body.tel
    || body.telephone || body.mobile || body.cell || body.phone_number || null
  );

  // Phone is required — reject submission without it
  if (!phone) {
    logger.warn(`[Form] Missing phone in submission for client ${clientId}`);
    throw new AppError('MISSING_PHONE', 'phone is required', 400);
  }

  // Validate phone format
  const phoneValidation = validatePhoneFormat(phone);
  if (!phoneValidation.valid) {
    logger.warn(`[Form] Invalid phone format: ${phone} — ${phoneValidation.error}`);
    throw new AppError('INVALID_PHONE', phoneValidation.error, 400);
  }

  const email = body.email || body.Email || body['your-email']
    || body.email_address || body.emailAddress || null;

  // Validate email format if provided
  if (email) {
    const emailValidation = validateEmailFormat(email);
    if (!emailValidation.valid) {
      logger.warn(`[Form] Invalid email format: ${email} — ${emailValidation.error}`);
      throw new AppError('INVALID_EMAIL', emailValidation.error, 400);
    }
  }

  const rawMessage = body.message || body.Message || body['your-message']
    || body.comments || body.inquiry || body.details || body.notes || body.body || '';
  const message = sanitizeInput(rawMessage, LENGTH_LIMITS.message);

  const rawService = body.service || body.Service || body.service_type
    || body.serviceType || body['service-type'] || null;
  const service = rawService ? sanitizeInput(rawService, LENGTH_LIMITS.name) : null;

  const rawSource = body.utm_source || body.source || body.referrer || 'website_form';
  const source = sanitizeInput(rawSource, LENGTH_LIMITS.name);

  // Atomic upsert using INSERT ... ON CONFLICT (no race conditions)
  const leadId = randomUUID();
  await db.query(`
    INSERT INTO leads (id, client_id, phone, phone_encrypted, name, email, email_encrypted, source, score, stage, last_contact, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 7, 'new', datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(client_id, phone) DO UPDATE SET
      name = COALESCE(excluded.name, leads.name),
      email = COALESCE(excluded.email, leads.email),
      email_encrypted = COALESCE(excluded.email_encrypted, leads.email_encrypted),
      source = COALESCE(excluded.source, leads.source),
      last_contact = datetime('now'),
      updated_at = datetime('now')
  `, [leadId, clientId, phone, encrypt(phone), name || null, email || null, email ? encrypt(email) : null, source], 'run');

  // Log inbound message
  await db.query(`
    INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'form', 'inbound', ?, 'received', datetime('now'), datetime('now'))
  `, [randomUUID(), clientId, leadId, phone, message || `Form submission: ${service || 'General inquiry'}`], 'run');

  // Deduplication: only trigger speed-to-lead if not a duplicate within 5 minutes
  if (!isDuplicateSpeedToLead(phone, email)) {
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

  // Outbound webhook: notify client CRM/callback URL if configured
  if (client.lead_webhook_url) {
    try {
      const { enqueue } = require('../utils/webhookQueue');
      await enqueue(
        client.lead_webhook_url,
        {
          event: 'lead.created',
          clientId,
          leadId,
          name: name || null,
          phone: phone || null,
          email: email || null,
          service: service || null,
          source,
          message: message || null,
        },
        { 'X-Client-Id': clientId }
      );
    } catch (err) {
      logger.error('[Form] Webhook enqueue failed:', err.message);
    }
  }

  logger.info(`[Form] Processed: ${name || phone} → ${client.business_name}`);
}

// POST /webhooks/form (no clientId in URL — reads client_id from body)
router.post('/', formRateLimit, validateBody(FormSubmissionSchema), async (req, res) => {
  const body = req.body || {};
  const clientId = body.client_id || body.clientId;
  if (!clientId) {
    return res.status(400).json({ success: false, error: 'client_id required in body', code: 'MISSING_CLIENT_ID' });
  }
  if (!isValidUUID(clientId)) {
    return res.status(400).json({ success: false, error: 'invalid client_id format', code: 'INVALID_CLIENT_ID' });
  }

  const db = req.app.locals.db;
  if (!db) {
    logger.error('[Form] No database connection');
    return res.status(500).json({ success: false, error: 'Service unavailable', code: 'DB_UNAVAILABLE' });
  }

  try {
    await processFormSubmission(db, body, clientId, req);
    return res.status(200).json({ success: true, data: { status: 'received', message: 'Lead captured' } });
  } catch (err) {
    if (err.name === 'AppError') {
      logger.warn(`[Form] Validation error (${err.code}): ${err.message}`);
      return res.status(err.statusCode).json({ success: false, error: err.message, code: err.code });
    }
    logger.error('[Form] Unexpected error:', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// POST /webhooks/form/:clientId
// Accepts form submissions from any source (WordPress, Typeform, Wix, Squarespace, custom HTML)
// Supports JSON and URL-encoded bodies
// Field aliases: Contact Form 7, Typeform, generic caps, standard
router.post('/:clientId', formRateLimit, validateParams(FormParamsSchema), validateBody(FormSubmissionSchema), async (req, res) => {
  const clientId = req.params.clientId;

  if (!isValidUUID(clientId)) {
    logger.warn(`[Form] Invalid clientId format: ${clientId}`);
    return res.status(400).json({ success: false, error: 'invalid client_id format', code: 'INVALID_CLIENT_ID' });
  }

  const db = req.app.locals.db;
  if (!db) {
    logger.error('[Form] No database connection');
    return res.status(500).json({ success: false, error: 'Service unavailable', code: 'DB_UNAVAILABLE' });
  }

  try {
    await processFormSubmission(db, req.body || {}, clientId, req);
    return res.status(200).json({ success: true, data: { status: 'received', message: 'Lead captured' } });
  } catch (err) {
    if (err.name === 'AppError') {
      logger.warn(`[Form] Validation error (${err.code}): ${err.message}`);
      return res.status(err.statusCode).json({ success: false, error: err.message, code: err.code });
    }
    logger.error('[Form] Error processing submission:', err.message, err.stack);
    return res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
module.exports.cleanupFormTimers = cleanupFormTimers;
