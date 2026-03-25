const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const telegram = require('../utils/telegram');
const { triggerSpeedSequence } = require('../utils/speed-to-lead');
const { normalizePhone } = require('../utils/phone');
const { isValidUUID, isValidPhone, isValidEmail, sanitizeString } = require('../utils/validate');

// Rate limiting for form submissions
const formRateLimits = new Map();
const FORM_RATE_LIMIT = 10; // max submissions per minute per IP
const FORM_RATE_WINDOW = 60000; // 1 minute

function formRateLimit(req, res, next) {
  const key = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = formRateLimits.get(key);

  if (record) {
    // Clean old entries
    record.timestamps = record.timestamps.filter(t => now - t < FORM_RATE_WINDOW);
    if (record.timestamps.length >= FORM_RATE_LIMIT) {
      console.warn(`[forms] Rate limit exceeded for ${key}`);
      return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
    }
    record.timestamps.push(now);
  } else {
    formRateLimits.set(key, { timestamps: [now] });
  }

  // Cleanup old entries every 5 minutes
  if (formRateLimits.size > 5000) {
    for (const [k, v] of formRateLimits) {
      if (now - Math.max(...v.timestamps) > FORM_RATE_WINDOW) formRateLimits.delete(k);
    }
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
    if (!client) { console.error(`[Form] Unknown client: ${clientId}`); return; }

    const name = body.name || body.first_name || body['your-name'] || body.fullName || body.full_name || null;
    const phone = normalizePhone(body.phone || body.Phone || body['your-phone'] || body.tel || body.mobile || null);
    const email = body.email || body.Email || body['your-email'] || null;

    // Validate phone if provided
    if (phone && !isValidPhone(phone)) {
      console.warn(`[Form] Invalid phone format: ${phone}`);
      return;
    }

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      console.warn(`[Form] Invalid email format: ${email}`);
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
          telegram.sendMessage(client.telegram_chat_id,
            `&#128203; <b>New form submission (no phone)</b>\n\n` +
            (name ? `<b>Name:</b> ${name}\n` : '') + `<b>Email:</b> ${email}\n` +
            (message ? `<b>Message:</b> "${message.substring(0, 200)}"\n` : '') +
            `\n&#9888;&#65039; No phone — can't auto-call or text.`
          ).catch(() => {});
        }
      }
      return;
    }

    const existingLead = db.prepare('SELECT id FROM leads WHERE client_id = ? AND phone = ?').get(clientId, phone);
    let leadId;
    if (existingLead) {
      leadId = existingLead.id;
      db.prepare(`UPDATE leads SET name = COALESCE(?, name), email = COALESCE(?, email), last_contact = datetime('now'), stage = 'new', updated_at = datetime('now') WHERE id = ?`).run(name, email, leadId);
    } else {
      leadId = randomUUID();
      db.prepare(`INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 7, 'new', datetime('now'), datetime('now'), datetime('now'))`).run(leadId, clientId, name, phone, email, source);
    }

    db.prepare(`INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'form', 'inbound', ?, 'received', datetime('now'), datetime('now'))`).run(randomUUID(), clientId, leadId, phone, message || `Form: ${service || 'General inquiry'}`);

    await triggerSpeedSequence(db, { leadId, clientId, phone, name, email, message, service, source: 'form', client });

    try {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');
      const memory = getLeadMemory(db, phone, clientId);
      if (memory) {
        const decision = await think('form_submitted', { name, phone, email, message, service, source }, memory, db);
        await executeActions(db, decision.actions, memory);
      }
    } catch (brainErr) { console.error('[Brain] Form error:', brainErr.message); }

    console.log(`[Form] Processed: ${name || phone} → ${client.business_name}`);
  } catch (err) { console.error('[Form] Error:', err.message); }
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
    console.error('[Form] No database connection');
    return;
  }
  const clientId = req.params.clientId;

  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ? AND is_active = 1').get(clientId);
    if (!client) {
      console.error(`[Form] Unknown or inactive client: ${clientId}`);
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

    const message = (body.message || body.Message || body['your-message']
      || body.comments || body.inquiry || body.details || body.notes || '').substring(0, 2000);

    const service = body.service || body.Service || body.service_type
      || body.serviceType || body['service-type'] || null;

    const source = body.utm_source || body.source || body.referrer || 'website_form';

    // No phone — create lead with email only + notify client
    if (!phone) {
      console.log(`[Form] No phone in submission for ${clientId}`);
      if (email) {
        const leadId = randomUUID();
        db.prepare(`
          INSERT INTO leads (id, client_id, name, phone, source, score, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, 5, 'new', datetime('now'), datetime('now'), datetime('now'))
        `).run(leadId, clientId, name, source);

        if (client.telegram_chat_id) {
          telegram.sendMessage(
            client.telegram_chat_id,
            `📋 <b>New form submission (no phone)</b>\n\n` +
            (name ? `<b>Name:</b> ${name}\n` : '') +
            `<b>Email:</b> ${email}\n` +
            (message ? `<b>Message:</b> "${message.substring(0, 200)}"\n` : '') +
            `\n⚠️ No phone — can't auto-call or text.`
          ).catch(() => {});
        }
      }
      return;
    }

    // Upsert lead
    const existingLead = db.prepare(
      'SELECT id FROM leads WHERE client_id = ? AND phone = ?'
    ).get(clientId, phone);

    let leadId;
    if (existingLead) {
      leadId = existingLead.id;
      db.prepare(
        `UPDATE leads SET name = COALESCE(?, name), email = COALESCE(?, email), last_contact = datetime('now'),
         stage = 'new', updated_at = datetime('now') WHERE id = ?`
      ).run(name, email || null, leadId);
    } else {
      leadId = randomUUID();
      db.prepare(`
        INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 7, 'new', datetime('now'), datetime('now'), datetime('now'))
      `).run(leadId, clientId, name, phone, email || null, source);
    }

    // Log inbound message
    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'form', 'inbound', ?, 'received', datetime('now'), datetime('now'))
    `).run(randomUUID(), clientId, leadId, phone, message || `Form submission: ${service || 'General inquiry'}`);

    // Trigger triple-touch speed sequence
    await triggerSpeedSequence(db, {
      leadId, clientId, phone, name, email, message, service,
      source: 'form',
      client
    });

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
      console.error('[Brain] Form submission error:', brainErr.message);
    }

    console.log(`[Form] Speed sequence triggered: ${name || phone} → ${client.business_name}`);
  } catch (err) {
    console.error('[Form] Error processing submission:', err.message);
  }
});

module.exports = router;
