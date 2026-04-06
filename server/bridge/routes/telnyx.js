const express = require('express');
const router = express.Router();
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

const anthropic = new Anthropic();

const ANTHROPIC_TIMEOUT = 30000;

// Telnyx webhook signature verification
router.use((req, res, next) => {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) {
    logger.warn('[telnyx] TELNYX_PUBLIC_KEY not configured — skipping signature validation');
    return next();
  }
  try {
    const crypto = require('crypto');
    const signature = req.headers['telnyx-signature-ed25519'];
    const timestamp = req.headers['telnyx-timestamp'];

    if (!signature || !timestamp) {
      logger.warn('[telnyx] Missing telnyx-signature-ed25519 or telnyx-timestamp header');
      return next(); // Allow through with warning — might be test webhook
    }

    // Reconstruct signed content: timestamp + raw body
    const body = req.rawBody || '';
    const signedContent = timestamp + body;

    // Verify Ed25519 signature
    const publicKeyObj = crypto.createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    });

    const signatureBuf = Buffer.from(signature, 'base64');
    const isValid = crypto.verify(
      null,
      Buffer.from(signedContent, 'utf-8'),
      publicKeyObj,
      signatureBuf
    );

    if (!isValid) {
      logger.error('[telnyx] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    next();
  } catch (err) {
    logger.error('[telnyx] Signature validation error:', err.message);
    return res.status(401).json({ error: 'Webhook signature validation failed' });
  }
});

// POST / — Telnyx SMS webhook
router.post('/', (req, res) => {
  try {
    const { data } = req.body || {};

    // Respond immediately
    res.status(200).json({ success: true });

    const db = req.app.locals.db;
    if (!db) {
      logger.error('[telnyx] No database connection');
      return;
    }

    if (!data || !data.payload) {
      logger.warn('[telnyx] Missing data.payload in webhook');
      return;
    }

    const { payload } = data;

    // Validate required webhook fields
    if (!data.event_type || typeof data.event_type !== 'string') {
      logger.warn('[telnyx] Missing or invalid event_type in webhook');
      return;
    }

    if (!payload.direction || typeof payload.direction !== 'string') {
      logger.warn('[telnyx] Missing or invalid direction in webhook');
      return;
    }

    // Only process inbound messages
    if (data.event_type !== 'message.received' || payload.direction !== 'inbound') {
      logger.info(`[telnyx] Ignoring event_type: ${data.event_type}, direction: ${payload.direction}`);
      return;
    }

    const from = payload.from?.phone_number;
    const to = payload.to?.[0]?.phone_number;
    const body = payload.text;
    const messageId = payload.id;

    if (!from || typeof from !== 'string' || !to || typeof to !== 'string') {
      logger.warn('[telnyx] Missing or invalid from/to in SMS webhook');
      return;
    }

    if (from.length > 20 || to.length > 20) {
      logger.warn('[telnyx] Phone number exceeds length limit');
      return;
    }

    // Process async
    setImmediate(() => {
      try {
        handleInboundSMS(db, { from, to, body, messageId });
      } catch (err) {
        logger.error('[telnyx] setImmediate error:', err);
      }
    });
  } catch (err) {
    logger.error('[telnyx] Webhook parsing error:', err);
    res.status(200).json({ success: false }); // Still respond 200 to stop retries
  }
});

async function handleInboundSMS(db, { from, to, body, messageId }) {
  try {
    logger.info(`[telnyx] SMS from ${from ? from.replace(/\d(?=\d{4})/g, '*') : '?'} to ${to} (${(body || '').length} chars)`);

    // Idempotency: skip if this messageId was already processed (webhook retry)
    if (messageId) {
      const dup = db.prepare('SELECT id FROM messages WHERE message_sid = ?').get(messageId);
      if (dup) {
        logger.info(`[telnyx] Duplicate messageId ${messageId}, skipping`);
        return;
      }
    }

    // Identify client by matching To number
    // First try telnyx_phone, then fall back to twilio_phone for backwards compat
    const client = db.prepare(
      'SELECT * FROM clients WHERE telnyx_phone = ? OR twilio_phone = ? OR retell_phone = ?'
    ).get(to, to, to);

    if (!client) {
      logger.error(`[telnyx] No client found for number ${to}`);
      return;
    }

    const trimmed = (body || '').toUpperCase().trim();

    // Handle opt-out keywords (STOP, UNSUBSCRIBE, CANCEL, QUIT, END)
    if (/^(STOP|UNSUBSCRIBE|QUIT|END)$/.test(trimmed)) {
      await handleOptOut(db, client, from, to, trimmed);
    } else if (/^(START|SUBSCRIBE|YES)$/.test(trimmed) && trimmed !== 'YES') {
      // Handle re-opt-in (but not YES which is for booking)
      await handleOptIn(db, client, from, to);
    } else if (trimmed === 'CANCEL') {
      await handleCancel(db, client, from, to);
    } else if (trimmed === 'YES') {
      await handleYes(db, client, from, to);
    } else {
      await handleNormalMessage(db, client, from, to, body, messageId);
    }
  } catch (err) {
    logger.error('[telnyx] handleInboundSMS error:', err);
  }
}

async function handleOptOut(db, client, from, to, keyword) {
  try {
    const { recordOptOut } = require('../utils/optOut');
    recordOptOut(db, from, client.id, keyword);

    // Send confirmation and re-opt-in instructions
    const msg = `You've been unsubscribed from ${client.business_name || 'our'} messages. Reply START to resubscribe.`;
    await sendSMS(from, msg.slice(0, 1600), to);

    logger.info(`[telnyx] Recorded opt-out for ${from} (${keyword})`);
  } catch (err) {
    logger.error('[telnyx] handleOptOut error:', err);
  }
}

async function handleOptIn(db, client, from, to) {
  try {
    const { recordOptIn } = require('../utils/optOut');
    recordOptIn(db, from, client.id);

    const msg = `Welcome back! You're now subscribed to ${client.business_name || 'our'} messages.`;
    await sendSMS(from, msg.slice(0, 1600), to);

    logger.info(`[telnyx] Recorded opt-in for ${from}`);
  } catch (err) {
    logger.error('[telnyx] handleOptIn error:', err);
  }
}

async function handleCancel(db, client, from, replyFrom) {
  try {
    // Find most recent booking for this phone via leads table
    const lead = db.prepare(
      'SELECT calcom_booking_id FROM leads WHERE phone = ? AND client_id = ? AND calcom_booking_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1'
    ).get(from, client.id);

    if (!lead?.calcom_booking_id) {
      await sendSMS(from, 'No upcoming appointment found to cancel.', replyFrom);
      return;
    }

    const result = await cancelBooking(lead.calcom_booking_id);

    if (result.success) {
      // Update lead stage
      db.prepare(
        'UPDATE leads SET calcom_booking_id = NULL, stage = \'contacted\', updated_at = ? WHERE phone = ? AND client_id = ?'
      ).run(new Date().toISOString(), from, client.id);

      await sendSMS(from, 'Your appointment has been cancelled.', replyFrom);
      logger.info(`[telnyx] Booking ${lead.calcom_booking_id} cancelled for ${from}`);
    } else {
      await sendSMS(from, 'Sorry, we couldn\'t cancel your appointment right now. Please call us directly.', replyFrom);
    }
  } catch (err) {
    logger.error('[telnyx] handleCancel error:', err);
    await sendSMS(from, 'Sorry, something went wrong. Please call us directly.', replyFrom).catch(() => {});
  }
}

async function handleYes(db, client, from, replyFrom) {
  try {
    const bookingLink = client.calcom_booking_link;

    if (bookingLink) {
      const msg = `Book your appointment here: ${bookingLink}`;
      await sendSMS(from, msg.slice(0, 1600), replyFrom);
    } else {
      const msg = 'Please call us to schedule your appointment.';
      await sendSMS(from, msg.slice(0, 1600), replyFrom);
    }
  } catch (err) {
    logger.error('[telnyx] handleYes error:', err);
  }
}

async function handleNormalMessage(db, client, from, to, body, messageId) {
  try {
    // Check if AI is paused — log message but do not auto-reply
    if (!client.is_active) {
      logger.info(`[telnyx] AI paused for client ${client.id} — logging message from ${from} without reply`);
      // Upsert lead so the message is tracked
      const existingLead = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(from, client.id);
      let leadId;
      if (existingLead) {
        leadId = existingLead.id;
      } else {
        leadId = randomUUID();
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, 'new', ?, ?, ?)
        `).run(leadId, client.id, from, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      }
      // Log inbound message
      db.prepare(`
        INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, created_at)
        VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, datetime('now'))
      `).run(randomUUID(), client.id, leadId, from, body, messageId || null);
      // Notify owner via Telegram
      if (client.telegram_chat_id) {
        const tg = require('../utils/telegram');
        // Escape message body to prevent XSS in Telegram HTML
        const escapedBody = (body || '').substring(0, 200).replace(/[&<>"]/g, c => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
        }[c]));
        tg.sendMessage(
          client.telegram_chat_id,
          `⏸ <b>AI paused</b> — message received (no auto-reply)\n\nFrom: ${from}\nMessage: "${escapedBody}"`
        ).catch(() => {});
      }
      return;
    }

    // Rate limit: don't auto-reply if we already replied to this number in the last 5 minutes
    const recentOutbound = db.prepare(
      "SELECT COUNT(*) as c FROM messages WHERE phone = ? AND direction = 'outbound' AND created_at >= datetime('now','-5 minutes')"
    ).get(from);
    if (recentOutbound.c > 0) {
      logger.info(`[telnyx] Rate limited outbound to ${from} — already replied within 5 min`);
      // Still log the inbound message
      const existingLead2 = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(from, client.id);
      if (existingLead2) {
        db.prepare(`
          INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, created_at)
          VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, datetime('now'))
        `).run(randomUUID(), client.id, existingLead2.id, from, body, messageId || null);
      }
      return;
    }

    // Load client knowledge base
    let kb = '';
    if (!isValidUUID(client.id)) {
      logger.warn('[telnyx] Invalid client UUID, skipping KB load');
    } else {
      const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${client.id}.json`);
      try {
        // Verify path doesn't escape knowledge_bases directory (path traversal protection)
        const resolvedPath = path.resolve(kbPath);
        const kbDir = path.resolve(path.join(__dirname, '../../mcp/knowledge_bases'));
        if (!resolvedPath.startsWith(kbDir)) {
          logger.error('[telnyx] KB path traversal attempt detected');
        } else {
          const kbData = JSON.parse(await fs.promises.readFile(kbPath, 'utf8'));
          kb = typeof kbData === 'string' ? kbData : JSON.stringify(kbData, null, 2);
          if (kb.length > 5000) kb = kb.substring(0, 5000) + '\n[...truncated]';
        }
      } catch (err) {
        logger.error(`[telnyx] KB load failed for client ${client.id}:`, err.message);
      }
    }

    // Claude generates reply based on KB
    let reply = '';
    let confidence = 'medium';

    try {
      const resp = await withTimeout(
        (signal) => anthropic.messages.create({
          model: config.ai.model,
          max_tokens: 300,
          system: `You are a helpful SMS assistant for ${client.business_name || 'our business'}. Answer the customer's question using ONLY the following knowledge base information. Do not make up information not found in the knowledge base.

Knowledge Base:
${kb || 'No knowledge base available.'}

Reply in JSON format: {"reply": "your reply text (keep under 160 chars for SMS)", "confidence": "high" | "medium" | "low"}
If you cannot answer from the knowledge base, set confidence to "low".`,
          messages: [{ role: 'user', content: body }]
        }),
        ANTHROPIC_TIMEOUT,
        'Claude SMS reply generation'
      );

      const rawText = resp.content[0]?.text || '';
      try {
        const parsed = JSON.parse(rawText);
        // Validate parsed object has expected structure
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.reply === 'string') {
          reply = parsed.reply;
          confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';
        } else {
          // Parsed but invalid structure — fall back to raw text
          reply = rawText;
          confidence = 'medium';
        }
      } catch (parseErr) {
        // JSON.parse failed — use raw text as fallback
        logger.warn('[telnyx] Claude response JSON parse failed, using raw text:', parseErr.message);
        reply = rawText;
        confidence = 'medium';
      }
    } catch (err) {
      logger.error('[telnyx] Claude reply generation failed:', err.message);
      reply = 'Thanks for your message! We\'ll get back to you shortly.';
      confidence = 'low';
    }

    // Low confidence: send generic reply + notify owner
    if (confidence === 'low') {
      reply = 'Great question! Let me check with the team and get back to you shortly.';

      if (client.owner_phone) {
        // Fire and forget with error handling
        Promise.resolve().then(() =>
          sendSMS(
            client.owner_phone,
            `[ELYVN] Question from ${from} that needs your input:\n"${body}"`
          )
        ).catch(err => logger.error('[telnyx] Owner notification failed:', err.message));
      }
    }

    // Upsert lead + record messages in a single transaction to prevent race conditions
    const inboundId = randomUUID();
    const outboundId = randomUUID();
    const now = new Date().toISOString();

    const upsertAndRecord = db.transaction(() => {
      const existingLead = db.prepare(
        'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
      ).get(from, client.id);

      let leadId;
      if (existingLead) {
        leadId = existingLead.id;
        db.prepare('UPDATE leads SET last_contact = ?, updated_at = ? WHERE id = ?')
          .run(now, now, leadId);
      } else {
        leadId = randomUUID();
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, 'new', ?, ?, ?)
        `).run(leadId, client.id, from, now, now, now);
      }

      // Record inbound message
      db.prepare(`
        INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, confidence, created_at)
        VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, ?, datetime('now'))
      `).run(inboundId, client.id, leadId, from, body, messageId || null, confidence);

      return { leadId, isNew: !existingLead };
    });

    const { leadId, isNew: isNewLead } = upsertAndRecord();

    // Send reply via Telnyx REST API
    // Truncate to Telnyx max for concatenated SMS (1600 chars = 10 segments)
    const truncatedReply = reply.slice(0, 1600);
    await sendSMS(from, truncatedReply, to);

    // Record outbound message
    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, confidence, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'auto_replied', ?, datetime('now'))
    `).run(outboundId, client.id, leadId, from, reply, confidence);

    // Broadcast real-time update
    try {
      const { broadcast } = require('../utils/websocket');
      broadcast('new_message', {
        id: inboundId,
        phone: from,
        direction: 'inbound',
        body,
        confidence,
        lead_id: leadId
      });
    } catch (err) {
      logger.warn('[telnyx] WebSocket broadcast error:', err.message);
    }

    // Schedule follow-up touch for brand-new SMS contacts
    if (isNewLead) {
      try {
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
          VALUES (?, ?, ?, 2, 'nudge', NULL, 'pending', ?, 'scheduled')
        `).run(randomUUID(), leadId, client.id, tomorrow);
      } catch (fuErr) {
        logger.error('[telnyx] Follow-up scheduling error:', fuErr.message);
      }
    }

    // === Telegram notification ===
    try {
      const clientForNotify = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
      if (clientForNotify && clientForNotify.telegram_chat_id) {
        if (confidence === 'low') {
          const { text, buttons } = telegram.formatEscalation(
            { phone: from, body, id: messageId || randomUUID() },
            reply,
            clientForNotify
          );
          telegram.sendMessage(clientForNotify.telegram_chat_id, text, { reply_markup: { inline_keyboard: buttons } });
        } else {
          const { text, buttons } = telegram.formatMessageNotification(
            { phone: from, body, id: messageId || randomUUID() },
            reply,
            confidence,
            clientForNotify
          );
          telegram.sendMessage(clientForNotify.telegram_chat_id, text, { reply_markup: { inline_keyboard: buttons } });
        }
      }
    } catch (tgErr) {
      logger.error('[telnyx] Telegram notification failed:', tgErr.message);
    }

    logger.info(`[telnyx] Replied to ${from ? from.replace(/\d(?=\d{4})/g, '*') : '?'}: ${reply.substring(0, 50)}...`);

    // === BRAIN — autonomous post-SMS decisions ===
    try {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');

      const memory = getLeadMemory(db, from, client.id);
      if (memory) {
        const decision = await think('sms_received', {
          from, body, auto_reply: reply, confidence,
          was_escalated: confidence === 'low',
        }, memory, db);
        await executeActions(db, decision.actions, memory);
      }
    } catch (brainErr) {
      logger.error('[Brain] Post-SMS error:', brainErr.message);
    }
  } catch (err) {
    logger.error('[telnyx] handleNormalMessage error:', err);
  }
}

module.exports = router;
