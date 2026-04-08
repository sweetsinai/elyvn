/**
 * Twilio Inbound SMS Webhook Handler
 *
 * Receives inbound SMS from Twilio and processes them through
 * the same AI conversation pipeline as Telnyx.
 *
 * Twilio sends form-encoded POST requests (not JSON).
 * We validate the request signature if TWILIO_AUTH_TOKEN is set.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { sendSMS } = require('../utils/sms');
const telegram = require('../utils/telegram');
const { cancelBooking } = require('../utils/calcom');
const config = require('../utils/config');
const fs = require('fs');
const path = require('path');
const { isValidUUID } = require('../utils/validate');
const { withTimeout } = require('../utils/resilience');
const { logger } = require('../utils/logger');
const { generateSystemPrompt } = require('../utils/nicheTemplates');
const { appendEvent, Events } = require('../utils/eventStore');
const { encrypt } = require('../utils/encryption');
const { AppError } = require('../utils/AppError');
const { isAsync } = require('../utils/dbAdapter');

const { ANTHROPIC_TIMEOUT } = require('../config/timing');
const anthropic = new Anthropic();

/**
 * Validate Twilio request signature (X-Twilio-Signature)
 */
function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[twilio] TWILIO_AUTH_TOKEN not set in production — rejecting webhook');
      return false;
    }
    logger.warn('[twilio] TWILIO_AUTH_TOKEN not set — skipping signature validation (dev only)');
    return true;
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    logger.warn('[twilio] Missing X-Twilio-Signature header');
    return false;
  }

  // Reconstruct the full URL Twilio used
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;

  // Sort POST params and append to URL
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  // HMAC-SHA1 signature
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(data)
    .digest('base64');

  const sigBuf = Buffer.from(signature, 'base64');
  const expectedBuf = Buffer.from(expected, 'base64');
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// Parse form-encoded body (Twilio sends application/x-www-form-urlencoded)
router.use(express.urlencoded({ extended: false }));

/**
 * POST /webhooks/twilio — Inbound SMS from Twilio
 *
 * Twilio POST fields: From, To, Body, MessageSid, AccountSid, etc.
 */
router.post('/', async (req, res) => {
  const db = req.app.locals.db;

  // Validate signature
  if (!validateTwilioSignature(req)) {
    logger.warn('[twilio] Invalid request signature — rejecting');
    return res.status(403).send('<Response></Response>');
  }

  const from = req.body?.From;
  const to = req.body?.To;
  const text = req.body?.Body || '';
  const messageSid = req.body?.MessageSid;

  const correlationId = req.headers['x-request-id'] || messageSid || randomUUID();

  if (!from || !text) {
    logger.warn('[twilio] Missing From or Body in webhook', { correlationId });
    return res.status(400).send('<Response></Response>');
  }

  logger.info(`[twilio] Inbound SMS from ${from}: "${text.substring(0, 80)}"`, { correlationId });

  // Respond immediately with empty TwiML (Twilio expects XML response)
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  // Process asynchronously
  setImmediate(async () => {
    try {
      // Idempotency: skip if this MessageSid was already processed (webhook retry)
      if (messageSid) {
        const dup = await db.query('SELECT id FROM messages WHERE message_sid = ?', [messageSid], 'get');
        if (dup) {
          logger.info(`[twilio] Duplicate MessageSid ${messageSid}, skipping (idempotent)`, { correlationId });
          return;
        }
      }

      // Find which client owns this phone number
      const client = await db.query(
        'SELECT * FROM clients WHERE twilio_phone = ? AND is_active = 1',
        [to],
        'get'
      );

      if (!client) {
        logger.warn(`[twilio] No active client for number ${to}`, { correlationId });
        return;
      }

      // Check for opt-out keywords
      const optOutKeywords = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
      if (optOutKeywords.includes(text.trim().toUpperCase())) {
        try {
          await db.query(
            'INSERT OR IGNORE INTO sms_opt_outs (id, phone, client_id, created_at) VALUES (?, ?, ?, ?)',
            [randomUUID(), from, client.id, new Date().toISOString()],
            'run'
          );
          logger.info(`[twilio] Opt-out recorded: ${from} for client ${client.id}`, { correlationId });
        } catch (err) {
          logger.error('[twilio] Opt-out insert error:', { correlationId, error: err.message });
        }
        return;
      }

      // Check for opt-in keywords
      const optInKeywords = ['START', 'YES', 'UNSTOP'];
      if (optInKeywords.includes(text.trim().toUpperCase())) {
        try {
          await db.query('DELETE FROM sms_opt_outs WHERE phone = ? AND client_id = ?', [from, client.id], 'run');
          logger.info(`[twilio] Opt-in recorded: ${from} for client ${client.id}`, { correlationId });
          await sendSMS(from, `You've been re-subscribed to messages from ${client.business_name}. Reply STOP to opt out.`, to);
        } catch (err) {
          logger.error('[twilio] Opt-in error:', { correlationId, error: err.message });
        }
        return;
      }

      let lead;
      if (isAsync(db)) {
        // Postgres: async transaction via manual BEGIN/COMMIT
        await db.query('BEGIN', [], 'run');
        try {
          let existing = await db.query(
            'SELECT * FROM leads WHERE phone = ? AND client_id = ?',
            [from, client.id], 'get'
          );
          if (!existing) {
            const leadId = randomUUID();
            const now = new Date().toISOString();
            await db.query(
              'INSERT INTO leads (id, client_id, phone, stage, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [leadId, client.id, from, 'new', 'sms_inbound', now, now], 'run'
            );
            try { await db.query('UPDATE leads SET phone_encrypted = ? WHERE id = ?', [encrypt(from), leadId], 'run'); } catch (encErr) { logger.warn('[twilio] phone encryption failed:', { correlationId, error: encErr.message }); }
            existing = { id: leadId, client_id: client.id, phone: from, name: null };
            logger.info(`[twilio] New lead created: ${leadId} for ${from}`, { correlationId });
          }
          lead = existing;
          await db.query('COMMIT', [], 'run');
        } catch (txErr) {
          await db.query('ROLLBACK', [], 'run');
          throw txErr;
        }
      } else {
        // SQLite: sync transaction
        const upsertLead = db.transaction((phone, clientId) => {
          let existing = db.prepare(
            'SELECT * FROM leads WHERE phone = ? AND client_id = ?'
          ).get(phone, clientId);
          if (!existing) {
            const leadId = randomUUID();
            const now = new Date().toISOString();
            db.prepare(
              'INSERT INTO leads (id, client_id, phone, stage, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(leadId, clientId, phone, 'new', 'sms_inbound', now, now);
            try { db.prepare('UPDATE leads SET phone_encrypted = ? WHERE id = ?').run(encrypt(phone), leadId); } catch (encErr) { logger.warn('[twilio] phone encryption failed:', { correlationId, error: encErr.message }); }
            existing = { id: leadId, client_id: clientId, phone, name: null };
            logger.info(`[twilio] New lead created: ${leadId} for ${phone}`, { correlationId });
          }
          return existing;
        });
        lead = upsertLead(from, client.id);
      }

      // Fire-and-forget: emit LeadCreated if new
      try {
        if (!lead.name && lead.id) {
          // New lead (no name yet — freshly inserted)
          appendEvent(db, lead.id, 'lead', Events.LeadCreated, { phone: from, source: 'sms_inbound' }, client.id);
        }
      } catch (_) {}

      // Store inbound message
      const msgId = randomUUID();
      const now = new Date().toISOString();
      try {
        await db.query(
          'INSERT INTO messages (id, lead_id, client_id, direction, channel, body, message_sid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [msgId, lead.id, client.id, 'inbound', 'sms', text, messageSid, now],
          'run'
        );
      } catch (err) {
        logger.error('[twilio] Message insert error:', { correlationId, error: err.message });
      }

      // Get conversation history for context
      const history = (await db.query(
        'SELECT direction, body, created_at FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10',
        [lead.id],
        'all'
      )).reverse();

      // Load knowledge base (cached)
      let kbContent = '';
      try {
        const { loadKnowledgeBase } = require('../utils/kbCache');
        kbContent = await loadKnowledgeBase(client.id);
      } catch (err) {
        logger.warn(`[twilio] KB load failed for client ${client.id}:`, { correlationId, error: err.message });
      }

      // Build AI prompt — use niche-specific template if available
      const nichePrompt = generateSystemPrompt(client);
      const systemPrompt = `${nichePrompt}

CHANNEL: SMS — keep replies SHORT (under 160 chars if possible). Be warm and helpful.
${kbContent ? `\nAdditional knowledge base:\n${kbContent}` : ''}`;

      const messages = history.map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.body
      }));

      // Ensure last message is the current inbound
      if (!messages.length || messages[messages.length - 1].content !== text) {
        messages.push({ role: 'user', content: text });
      }

      // Call Claude for response
      const aiResponse = await withTimeout(
        anthropic.messages.create({
          model: config.ai.model,
          max_tokens: config.ai.maxTokens,
          system: systemPrompt,
          messages
        }),
        ANTHROPIC_TIMEOUT
      );

      const replyText = aiResponse.content?.[0]?.text;

      if (replyText) {
        // Send reply
        const result = await sendSMS(from, replyText, to);

        // Store outbound message
        if (result.success) {
          const outMsgId = randomUUID();
          await db.query(
            'INSERT INTO messages (id, lead_id, client_id, direction, channel, body, message_sid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [outMsgId, lead.id, client.id, 'outbound', 'sms', replyText, result.messageId, new Date().toISOString()],
            'run'
          );
          try { appendEvent(db, lead.id, 'message', Events.SMSSent, { phone: from, channel: 'sms', messageId: outMsgId }, client.id); } catch (_) {}
        }

        // Notify owner via Telegram (skip in digest mode)
        if (client.telegram_chat_id && client.notification_mode !== 'digest') {
          const leadName = lead.name || from;
          telegram.sendMessage(
            client.telegram_chat_id,
            `📱 SMS from ${leadName}:\n"${text.substring(0, 200)}"\n\n🤖 AI replied:\n"${replyText.substring(0, 200)}"`
          ).catch(err => logger.error('[twilio] Telegram notify error:', { correlationId, error: err.message }));
        }
      }

      // Update lead timestamp
      await db.query('UPDATE leads SET updated_at = ? WHERE id = ?', [new Date().toISOString(), lead.id], 'run');

    } catch (err) {
      logger.error('[twilio] Processing error', { correlationId, code: 'PROCESSING_ERROR', from, messageSid, error: err.message, stack: err.stack });
    }
  });
});

module.exports = router;
