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

const anthropic = new Anthropic();
const ANTHROPIC_TIMEOUT = 30000;

/**
 * Validate Twilio request signature (X-Twilio-Signature)
 */
function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true; // Skip if not configured

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

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
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

  if (!from || !text) {
    logger.warn('[twilio] Missing From or Body in webhook');
    return res.status(400).send('<Response></Response>');
  }

  logger.info(`[twilio] Inbound SMS from ${from}: "${text.substring(0, 80)}"`);

  // Respond immediately with empty TwiML (Twilio expects XML response)
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  // Process asynchronously
  setImmediate(async () => {
    try {
      // Idempotency: skip if this MessageSid was already processed (webhook retry)
      if (messageSid) {
        const dup = db.prepare('SELECT id FROM messages WHERE message_sid = ?').get(messageSid);
        if (dup) {
          logger.info(`[twilio] Duplicate MessageSid ${messageSid}, skipping (idempotent)`);
          return;
        }
      }

      // Find which client owns this phone number
      const client = db.prepare(
        'SELECT * FROM clients WHERE twilio_phone = ? AND is_active = 1'
      ).get(to);

      if (!client) {
        logger.warn(`[twilio] No active client for number ${to}`);
        return;
      }

      // Check for opt-out keywords
      const optOutKeywords = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
      if (optOutKeywords.includes(text.trim().toUpperCase())) {
        try {
          db.prepare(
            'INSERT OR IGNORE INTO sms_opt_outs (id, phone, client_id, created_at) VALUES (?, ?, ?, ?)'
          ).run(randomUUID(), from, client.id, new Date().toISOString());
          logger.info(`[twilio] Opt-out recorded: ${from} for client ${client.id}`);
        } catch (err) {
          logger.error('[twilio] Opt-out insert error:', err.message);
        }
        return;
      }

      // Check for opt-in keywords
      const optInKeywords = ['START', 'YES', 'UNSTOP'];
      if (optInKeywords.includes(text.trim().toUpperCase())) {
        try {
          db.prepare('DELETE FROM sms_opt_outs WHERE phone = ? AND client_id = ?').run(from, client.id);
          logger.info(`[twilio] Opt-in recorded: ${from} for client ${client.id}`);
          await sendSMS(from, `You've been re-subscribed to messages from ${client.business_name}. Reply STOP to opt out.`, to);
        } catch (err) {
          logger.error('[twilio] Opt-in error:', err.message);
        }
        return;
      }

      // Find or create lead
      let lead = db.prepare(
        'SELECT * FROM leads WHERE phone = ? AND client_id = ?'
      ).get(from, client.id);

      if (!lead) {
        const leadId = randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO leads (id, client_id, phone, stage, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(leadId, client.id, from, 'new', 'sms_inbound', now, now);
        lead = { id: leadId, client_id: client.id, phone: from, name: null };
        logger.info(`[twilio] New lead created: ${leadId} for ${from}`);
      }

      // Store inbound message
      const msgId = randomUUID();
      const now = new Date().toISOString();
      try {
        db.prepare(
          'INSERT INTO messages (id, lead_id, client_id, direction, channel, body, message_sid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(msgId, lead.id, client.id, 'inbound', 'sms', text, messageSid, now);
      } catch (err) {
        logger.error('[twilio] Message insert error:', err.message);
      }

      // Get conversation history for context
      const history = db.prepare(
        'SELECT direction, body, created_at FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10'
      ).all(lead.id).reverse();

      // Load knowledge base
      let kbContent = '';
      if (client.kb_path) {
        try {
          // Resolve KB path relative to project root and ensure it stays within allowed directory
          const kbBaseDir = path.resolve(__dirname, '../../mcp/knowledge_bases');
          const resolvedPath = path.resolve(__dirname, '../..', client.kb_path);
          if (!resolvedPath.startsWith(kbBaseDir)) {
            logger.warn(`[twilio] KB path traversal blocked: ${client.kb_path}`);
          } else {
            kbContent = await fs.promises.readFile(resolvedPath, 'utf-8');
          }
        } catch (err) {
          logger.warn(`[twilio] KB not found: ${client.kb_path}`);
        }
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
          db.prepare(
            'INSERT INTO messages (id, lead_id, client_id, direction, channel, body, message_sid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(randomUUID(), lead.id, client.id, 'outbound', 'sms', replyText, result.messageId, new Date().toISOString());
        }

        // Notify owner via Telegram (skip in digest mode)
        if (client.telegram_chat_id && client.notification_mode !== 'digest') {
          const leadName = lead.name || from;
          telegram.sendMessage(
            client.telegram_chat_id,
            `📱 SMS from ${leadName}:\n"${text.substring(0, 200)}"\n\n🤖 AI replied:\n"${replyText.substring(0, 200)}"`
          ).catch(err => logger.error('[twilio] Telegram notify error:', err.message));
        }
      }

      // Update lead timestamp
      db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), lead.id);

    } catch (err) {
      logger.error('[twilio] Inbound processing error:', err.message);
    }
  });
});

module.exports = router;
