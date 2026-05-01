/**
 * Handles a normal (non-keyword) inbound SMS:
 * rate-limit check → KB load → Claude reply → DB upsert → send → events → Telegram → Brain.
 */

const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const { sendSMS } = require('../../utils/sms');
const telegram = require('../../utils/telegram');
const config = require('../../utils/config');
const { isValidUUID } = require('../../utils/validators');
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
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recentOutbound = await db.query(
      "SELECT COUNT(*) as c FROM messages WHERE phone = ? AND client_id = ? AND direction = 'outbound' AND created_at >= ?",
      [from, client.id, fiveMinAgo],
      'get'
    );
    if (recentOutbound.c > 0) {
      logger.info(`[legacySms] Rate limited outbound to ${from} — already replied within 5 min`);
      const existingLead2 = await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ?', [from, client.id], 'get');
      if (existingLead2) {
        const convId = await ensureConversation(db, client.id, from, existingLead2.id);
        const rlNow = new Date().toISOString();
        await db.query(`
          INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, conversation_id, delivery_status, created_at)
          VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, ?, 'received', ?)
        `, [randomUUID(), client.id, existingLead2.id, from, body, messageId || null, convId, rlNow], 'run');
        // Update conversation preview
        try {
          const preview = (body || '').substring(0, 100);
          await db.query("UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?", [rlNow, preview, rlNow, convId], 'run');
        } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
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

    // Ensure conversation exists for this (client, phone) pair
    const conversationId = await ensureConversation(db, client.id, from, leadId);

    // Link the inbound message (inserted by upsertLead) to the conversation
    if (conversationId) {
      try {
        await db.query(
          "UPDATE messages SET conversation_id = ?, delivery_status = 'received' WHERE id = ?",
          [conversationId, inboundId], 'run'
        );
        const linkNow = new Date().toISOString();
        const preview = (body || '').substring(0, 100);
        await db.query(
          "UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?",
          [linkNow, preview, linkNow, conversationId], 'run'
        );
      } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
    }

    // Fire-and-forget event emission
    try {
      if (isNewLead) {
        appendEvent(db, leadId, 'lead', Events.LeadCreated, { phone: from, source: 'sms_inbound' }, client.id);
      }
      appendEvent(db, leadId, 'message', Events.ReplyReceived, { phone: from, channel: 'sms', direction: 'inbound' }, client.id);
    } catch (_evtErr) { /* event emission must not break request */ }

    // Outbound webhook: fire sms.received
    try {
      const { fireSmsReceived } = require('../../utils/webhookEvents');
      await fireSmsReceived(client, { from, to, body, messageId, leadId });
    } catch (_whErr) { /* webhook fire must not break request */ }

    // Send reply via Legacy SMS REST API (max SMS_MAX_LENGTH chars = 10 concatenated segments)
    const truncatedReply = finalReply.slice(0, SMS_MAX_LENGTH);
    await sendSMS(from, truncatedReply, to, db, client.id);

    // Record outbound message (with conversation_id + delivery_status)
    const outNow = new Date().toISOString();
    await db.query(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, confidence, conversation_id, delivery_status, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'auto_replied', ?, ?, 'sent', ?)
    `, [outboundId, client.id, leadId, from, finalReply, finalConfidence, conversationId, outNow], 'run');

    // Update conversation with latest message
    try {
      const preview = finalReply.substring(0, 100);
      await db.query(`
        UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ?
        WHERE id = ?
      `, [outNow, preview, outNow, conversationId], 'run');
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

    try { appendEvent(db, leadId, 'message', Events.SMSSent, { phone: from, channel: 'sms', messageId: outboundId }, client.id); } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

    // Outbound webhook: fire sms.sent
    try {
      const { fireSmsSent } = require('../../utils/webhookEvents');
      await fireSmsSent(client, { to: from, from: to, body: finalReply, messageId: outboundId, leadId });
    } catch (_whErr) { /* webhook fire must not break request */ }

    // Broadcast real-time update
    try {
      const { broadcast } = require('../../utils/websocket');
      broadcast('new_message', { id: inboundId, conversationId, phone: from, direction: 'inbound', body, confidence: finalConfidence, lead_id: leadId }, client.id);
    } catch (err) {
      logger.warn('[legacySms] WebSocket broadcast error:', err.message);
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
        logger.error('[legacySms] Follow-up scheduling error:', fuErr.message);
      }
    }

    // Telegram notification
    await sendTelegramNotification(db, client, from, body, finalReply, finalConfidence, messageId);

    logger.info(`[legacySms] Replied to ${from ? from.replace(/\d(?=\d{4})/g, '*') : '?'}: ${finalReply.substring(0, 50)}...`);

    // BRAIN — autonomous post-SMS decisions
    try {
      const { getLeadMemory } = require('../../utils/leadMemory');
      const { think } = require('../../utils/brain');
      const { executeActions } = require('../../utils/actionExecutor');

      const memory = await getLeadMemory(db, from, client.id);
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
    logger.error('[legacySms] handleNormalMessage error:', err);
  }
}

// --- Helpers ---

async function handleAiPaused(db, client, from, to, body, messageId) {
  logger.info(`[legacySms] AI paused for client ${client.id} — logging message from ${from} without reply`);
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
    try { await db.query('UPDATE leads SET phone_encrypted = ? WHERE id = ?', [encrypt(from), leadId], 'run'); } catch (encErr) { logger.warn('[legacySms] phone encryption failed:', encErr.message); }
    try { appendEvent(db, leadId, 'lead', Events.LeadCreated, { phone: from, source: 'sms_inbound', ai_paused: true }, client.id); } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  }
  const convId = await ensureConversation(db, client.id, from, leadId);
  const pausedNow = new Date().toISOString();
  await db.query(`
    INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, conversation_id, delivery_status, created_at)
    VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, ?, 'received', ?)
  `, [randomUUID(), client.id, leadId, from, body, messageId || null, convId, pausedNow], 'run');
  try {
    const preview = (body || '').substring(0, 100);
    await db.query("UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?", [pausedNow, preview, pausedNow, convId], 'run');
  } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

  if (client.telegram_chat_id) {
    const tg = require('../../utils/telegram');
    const escapedBody = (body || '').substring(0, 200).replace(/[&<>"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[c]));
    tg.sendMessage(
      client.telegram_chat_id,
      `⏸ <b>AI paused</b> — message received (no auto-reply)\n\nFrom: ${from}\nMessage: "${escapedBody}"`
    ).catch(err => logger.warn('[legacySms] Telegram AI-paused notification failed', err.message));
  }
}

async function loadKnowledgeBase(client) {
  if (!isValidUUID(client.id)) {
    logger.warn('[legacySms] Invalid client UUID, skipping KB load');
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
    logger.error(`[legacySms] KB load failed for client ${client.id}:`, err.message);
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
      logger.warn('[legacySms] Claude response JSON parse failed, using raw text:', parseErr.message);
      return { reply: rawText, confidence: 'medium' };
    }
  } catch (err) {
    logger.error('[legacySms] Claude reply generation failed:', err.message);
    return { reply: 'Thanks for your message! We\'ll get back to you shortly.', confidence: 'low' };
  }
}

async function handleConfidence(client, from, body, reply, confidence) {
  if (confidence !== 'low') return { finalReply: reply, finalConfidence: confidence };

  const finalReply = 'Great question! Let me check with the team and get back to you shortly.';
  if (client.owner_phone) {
    Promise.resolve().then(() =>
      sendSMS(client.owner_phone, `[ELYVN] Question from ${from} that needs your input:\n"${body}"`, client.phone_number, db, client.id)
    ).catch(err => logger.error('[legacySms] Owner notification failed:', err.message));
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
    logger.error('[legacySms] Telegram notification failed:', tgErr.message);
  }
}

/**
 * Ensure a conversation row exists for (client_id, phone). Returns conversation ID.
 * On new inbound, also increments unread_count.
 */
async function ensureConversation(db, clientId, phone, leadId) {
  try {
    const existing = await db.query(
      'SELECT id FROM conversations WHERE client_id = ? AND lead_phone = ?',
      [clientId, phone], 'get'
    );
    if (existing) {
      // Increment unread count for inbound
      await db.query(
        "UPDATE conversations SET unread_count = unread_count + 1, updated_at = ? WHERE id = ?",
        [new Date().toISOString(), existing.id], 'run'
      );
      // Update lead_id if it was null and we now have one
      if (leadId) {
        await db.query(
          'UPDATE conversations SET lead_id = COALESCE(lead_id, ?) WHERE id = ?',
          [leadId, existing.id], 'run'
        );
      }
      return existing.id;
    }
    // Create new conversation
    const convId = randomUUID();
    let leadName = null;
    if (leadId) {
      const lead = await db.query('SELECT name FROM leads WHERE id = ?', [leadId], 'get');
      leadName = lead?.name || null;
    }
    const convNow = new Date().toISOString();
    await db.query(`
      INSERT INTO conversations (id, client_id, lead_id, lead_phone, lead_name, unread_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `, [convId, clientId, leadId, phone, leadName, convNow, convNow], 'run');
    return convId;
  } catch (err) {
    logger.warn('[legacySms] ensureConversation error:', err.message);
    return null;
  }
}

module.exports = { handleNormalMessage };
