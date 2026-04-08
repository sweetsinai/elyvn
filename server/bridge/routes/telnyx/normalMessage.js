/**
 * Handles a normal (non-keyword) inbound SMS:
 * rate-limit check → KB load → Claude reply → DB upsert → send → events → Telegram → Brain.
 */

const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const { sendSMS } = require('../../utils/sms');
const telegram = require('../../utils/telegram');
const config = require('../../utils/config');
const { isValidUUID } = require('../../utils/validate');
const { withTimeout } = require('../../utils/resilience');
const { logger } = require('../../utils/logger');
const { appendEvent, Events } = require('../../utils/eventStore');
const { encrypt } = require('../../utils/encryption');
const { upsertLeadAndRecordInbound } = require('./upsertLead');
const { ANTHROPIC_TIMEOUT, SMS_MAX_LENGTH } = require('../../config/timing');

const anthropic = new Anthropic();

async function handleNormalMessage(db, client, from, to, body, messageId) {
  try {
    // AI paused: log inbound but do not auto-reply
    if (!client.is_active) {
      await handleAiPaused(db, client, from, to, body, messageId);
      return;
    }

    // Rate limit: skip auto-reply if we already replied to this number in the last 5 minutes
    const recentOutbound = await db.query(
      "SELECT COUNT(*) as c FROM messages WHERE phone = ? AND direction = 'outbound' AND created_at >= datetime('now','-5 minutes')",
      [from],
      'get'
    );
    if (recentOutbound.c > 0) {
      logger.info(`[telnyx] Rate limited outbound to ${from} — already replied within 5 min`);
      const existingLead2 = await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ?', [from, client.id], 'get');
      if (existingLead2) {
        await db.query(`
          INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, created_at)
          VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, datetime('now'))
        `, [randomUUID(), client.id, existingLead2.id, from, body, messageId || null], 'run');
      }
      return;
    }

    // Load client knowledge base (cached)
    const kb = await loadKnowledgeBase(client);

    // Claude generates reply based on KB
    const { reply, confidence } = await generateReply(client, body, kb);

    // Low confidence: send generic reply + notify owner
    const { finalReply, finalConfidence } = await handleConfidence(client, from, body, reply, confidence);

    // Upsert lead + record inbound message in a transaction
    const inboundId = randomUUID();
    const outboundId = randomUUID();
    const { leadId, isNewLead } = await upsertLeadAndRecordInbound(db, {
      clientId: client.id, from, body, messageId, confidence: finalConfidence, inboundId
    });

    // Fire-and-forget event emission
    try {
      if (isNewLead) {
        appendEvent(db, leadId, 'lead', Events.LeadCreated, { phone: from, source: 'sms_inbound' }, client.id);
      }
      appendEvent(db, leadId, 'message', Events.ReplyReceived, { phone: from, channel: 'sms', direction: 'inbound' }, client.id);
    } catch (_evtErr) { /* event emission must not break request */ }

    // Send reply via Telnyx REST API (max SMS_MAX_LENGTH chars = 10 concatenated segments)
    const truncatedReply = finalReply.slice(0, SMS_MAX_LENGTH);
    await sendSMS(from, truncatedReply, to);

    // Record outbound message
    await db.query(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, confidence, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'auto_replied', ?, datetime('now'))
    `, [outboundId, client.id, leadId, from, finalReply, finalConfidence], 'run');

    try { appendEvent(db, leadId, 'message', Events.SMSSent, { phone: from, channel: 'sms', messageId: outboundId }, client.id); } catch (_) {}

    // Broadcast real-time update
    try {
      const { broadcast } = require('../../utils/websocket');
      broadcast('new_message', { id: inboundId, phone: from, direction: 'inbound', body, confidence: finalConfidence, lead_id: leadId });
    } catch (err) {
      logger.warn('[telnyx] WebSocket broadcast error:', err.message);
    }

    // Schedule follow-up touch for brand-new SMS contacts
    if (isNewLead) {
      try {
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await db.query(`
          INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
          VALUES (?, ?, ?, 2, 'nudge', NULL, 'pending', ?, 'scheduled')
        `, [randomUUID(), leadId, client.id, tomorrow], 'run');
      } catch (fuErr) {
        logger.error('[telnyx] Follow-up scheduling error:', fuErr.message);
      }
    }

    // Telegram notification
    await sendTelegramNotification(db, client, from, body, finalReply, finalConfidence, messageId);

    logger.info(`[telnyx] Replied to ${from ? from.replace(/\d(?=\d{4})/g, '*') : '?'}: ${finalReply.substring(0, 50)}...`);

    // BRAIN — autonomous post-SMS decisions
    try {
      const { getLeadMemory } = require('../../utils/leadMemory');
      const { think } = require('../../utils/brain');
      const { executeActions } = require('../../utils/actionExecutor');

      const memory = getLeadMemory(db, from, client.id);
      if (memory) {
        const decision = await think('sms_received', {
          from, body, auto_reply: finalReply, confidence: finalConfidence,
          was_escalated: finalConfidence === 'low',
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

// --- Helpers ---

async function handleAiPaused(db, client, from, to, body, messageId) {
  logger.info(`[telnyx] AI paused for client ${client.id} — logging message from ${from} without reply`);
  const existingLead = await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ?', [from, client.id], 'get');
  let leadId;
  if (existingLead) {
    leadId = existingLead.id;
  } else {
    leadId = randomUUID();
    await db.query(`
      INSERT INTO leads (id, client_id, phone, stage, last_contact, created_at, updated_at)
      VALUES (?, ?, ?, 'new', ?, ?, ?)
    `, [leadId, client.id, from, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()], 'run');
    try { await db.query('UPDATE leads SET phone_encrypted = ? WHERE id = ?', [encrypt(from), leadId], 'run'); } catch (encErr) { logger.warn('[telnyx] phone encryption failed:', encErr.message); }
    try { appendEvent(db, leadId, 'lead', Events.LeadCreated, { phone: from, source: 'sms_inbound', ai_paused: true }, client.id); } catch (_) {}
  }
  await db.query(`
    INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, created_at)
    VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, datetime('now'))
  `, [randomUUID(), client.id, leadId, from, body, messageId || null], 'run');

  if (client.telegram_chat_id) {
    const tg = require('../../utils/telegram');
    const escapedBody = (body || '').substring(0, 200).replace(/[&<>"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[c]));
    tg.sendMessage(
      client.telegram_chat_id,
      `⏸ <b>AI paused</b> — message received (no auto-reply)\n\nFrom: ${from}\nMessage: "${escapedBody}"`
    ).catch(err => logger.warn('[telnyx] Telegram AI-paused notification failed', err.message));
  }
}

async function loadKnowledgeBase(client) {
  if (!isValidUUID(client.id)) {
    logger.warn('[telnyx] Invalid client UUID, skipping KB load');
    return '';
  }
  try {
    const { loadKnowledgeBase: loadKB } = require('../../utils/kbCache');
    const raw = await loadKB(client.id);
    if (!raw) return '';
    const kbData = JSON.parse(raw);
    let kb = typeof kbData === 'string' ? kbData : JSON.stringify(kbData, null, 2);
    if (kb.length > 5000) kb = kb.substring(0, 5000) + '\n[...truncated]';
    return kb;
  } catch (err) {
    logger.error(`[telnyx] KB load failed for client ${client.id}:`, err.message);
    return '';
  }
}

async function generateReply(client, body, kb) {
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
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.reply === 'string') {
        return {
          reply: parsed.reply,
          confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium'
        };
      }
      return { reply: rawText, confidence: 'medium' };
    } catch (parseErr) {
      logger.warn('[telnyx] Claude response JSON parse failed, using raw text:', parseErr.message);
      return { reply: rawText, confidence: 'medium' };
    }
  } catch (err) {
    logger.error('[telnyx] Claude reply generation failed:', err.message);
    return { reply: 'Thanks for your message! We\'ll get back to you shortly.', confidence: 'low' };
  }
}

async function handleConfidence(client, from, body, reply, confidence) {
  if (confidence !== 'low') return { finalReply: reply, finalConfidence: confidence };

  const finalReply = 'Great question! Let me check with the team and get back to you shortly.';
  if (client.owner_phone) {
    Promise.resolve().then(() =>
      sendSMS(client.owner_phone, `[ELYVN] Question from ${from} that needs your input:\n"${body}"`)
    ).catch(err => logger.error('[telnyx] Owner notification failed:', err.message));
  }
  return { finalReply, finalConfidence: 'low' };
}

async function sendTelegramNotification(db, client, from, body, reply, confidence, messageId) {
  try {
    const clientForNotify = await db.query('SELECT * FROM clients WHERE id = ?', [client.id], 'get');
    if (!clientForNotify?.telegram_chat_id) return;

    if (confidence === 'low') {
      const { text, buttons } = telegram.formatEscalation(
        { phone: from, body, id: messageId || randomUUID() },
        reply, clientForNotify
      );
      telegram.sendMessage(clientForNotify.telegram_chat_id, text, { reply_markup: { inline_keyboard: buttons } });
    } else {
      const { text, buttons } = telegram.formatMessageNotification(
        { phone: from, body, id: messageId || randomUUID() },
        reply, confidence, clientForNotify
      );
      telegram.sendMessage(clientForNotify.telegram_chat_id, text, { reply_markup: { inline_keyboard: buttons } });
    }
  } catch (tgErr) {
    logger.error('[telnyx] Telegram notification failed:', tgErr.message);
  }
}

module.exports = { handleNormalMessage };
