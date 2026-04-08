'use strict';

const telegram = require('../../utils/telegram');
const { logger } = require('../../utils/logger');
const { handleCommand } = require('./commands');
const timing = require('../../config/timing');

// Rate limiting for Telegram callback queries
const callbackRateLimits = new Map();
const CALLBACK_RATE_LIMIT = timing.TELEGRAM_CALLBACK_RATE_LIMIT;
const CALLBACK_RATE_WINDOW = timing.TELEGRAM_CALLBACK_RATE_WINDOW_MS;

function callbackRateLimit(chatId) {
  const now = Date.now();
  const record = callbackRateLimits.get(chatId);

  if (record) {
    // Clean old entries
    record.timestamps = record.timestamps.filter(t => now - t < CALLBACK_RATE_WINDOW);
    if (record.timestamps.length >= CALLBACK_RATE_LIMIT) {
      logger.warn(`[telegram] Callback rate limit exceeded for chatId ${chatId}`);
      return false; // Rate limited
    }
    record.timestamps.push(now);
  } else {
    callbackRateLimits.set(chatId, { timestamps: [now] });
  }

  // Cleanup old entries every 5 minutes
  if (callbackRateLimits.size > 10000) {
    for (const [k, v] of callbackRateLimits) {
      const latest = v.timestamps[v.timestamps.length - 1] || 0;
      if (now - latest > CALLBACK_RATE_WINDOW) callbackRateLimits.delete(k);
    }
  }

  return true; // Not rate limited
}

async function handleCallback(db, callbackQuery) {
  if (!callbackQuery) return;
  const chatId = String(callbackQuery.message?.chat?.id || '');
  const data = callbackQuery.data || '';
  const callbackId = callbackQuery.id;

  if (!chatId || !data) return;

  // Rate limit callback queries
  if (!callbackRateLimit(chatId)) {
    logger.warn(`[telegram] Callback rate limited for chatId ${chatId}`);
    return;
  }

  // ── Quick-action buttons (no typing needed) ──
  if (data.startsWith('quick:')) {
    const action = data.split(':')[1];
    await telegram.answerCallback(callbackId, 'Loading...');
    // Simulate the command by building a fake message and running handleCommand
    const fakeMessage = {
      chat: { id: chatId },
      from: callbackQuery.from,
      text: `/${action}`,
    };
    await handleCommand(db, fakeMessage).catch(err =>
      logger.error('[telegram] quick-action error:', err)
    );
    return;
  }

  if (data.startsWith('transcript:')) {
    const callId = data.split(':')[1];
    const call = await db.query('SELECT transcript, caller_phone, created_at, summary FROM calls WHERE call_id = ?', [callId], 'get');
    if (call && call.transcript) {
      const transcript = call.transcript;
      if (transcript.length > 3500) {
        // Send as downloadable .txt file for long transcripts
        const header = [
          `ELYVN Call Transcript`,
          `Call ID: ${callId}`,
          `Caller: ${call.caller_phone || 'unknown'}`,
          `Date: ${call.created_at || 'unknown'}`,
          call.summary ? `Summary: ${call.summary}` : '',
          '─'.repeat(50),
          '',
        ].filter(Boolean).join('\n');
        const filename = `transcript-${callId.substring(0, 8)}.txt`;
        await telegram.sendDocument(chatId, header + transcript, filename, `<b>Full transcript</b> (${transcript.length} chars)`);
      } else {
        const escaped = transcript.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await telegram.sendMessage(chatId, `<b>Transcript</b>\n\n${escaped}`);
      }
    } else {
      await telegram.sendMessage(chatId, 'Transcript not available.');
    }
    await telegram.answerCallback(callbackId, 'Transcript sent');
  } else if (data.startsWith('msg_ok:')) {
    await telegram.answerCallback(callbackId, 'Noted — AI reply was good');
  } else if (data.startsWith('msg_takeover:')) {
    const parts = data.split(':');
    const phone = parts[2] || '';
    await telegram.answerCallback(callbackId, "You're handling this one");
    if (chatId) {
      const safePhone = phone.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await telegram.sendMessage(chatId, `You're handling this one.${safePhone ? ` Contact: ${safePhone}` : ''}`);
    }
  } else if (data.startsWith('reply_prompt:')) {
    // Owner wants to reply to a lead — send ForceReply prompt
    const phone = data.split(':')[1] || '';
    await telegram.answerCallback(callbackId, 'Type your reply below');
    // Send a prompt message with ForceReply — when the owner types a response,
    // the webhook receives it as a reply_to_message, which index.js routes to handleReply()
    const safePromptPhone = phone.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await telegram.sendMessage(chatId,
      `<b>Reply to ${safePromptPhone}</b>\nType your message below (reply to this message):`,
      {
        reply_markup: JSON.stringify({
          force_reply: true,
          selective: true,
          input_field_placeholder: 'Type your SMS reply...',
        }),
        // Embed phone in the message so handleReply can extract it
      }
    );
    return;
  } else if (data.startsWith('cancel_speed:')) {
    const leadId = data.split(':')[1];

    // Validate UUID format before touching the DB
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!leadId || !UUID_RE.test(leadId)) {
      logger.warn(`[telegram] cancel_speed: invalid leadId "${leadId}"`);
      await telegram.answerCallback(callbackId, 'Invalid lead ID.');
      return;
    }

    try {
      const result = await db.query(
        `UPDATE followups
         SET status = 'cancelled'
         WHERE lead_id = ?
           AND status = 'scheduled'
           AND (
             content_source IN ('speed_to_lead', 'template')
             OR touch_number IN (1, 2, 3, 4, 5)
           )`,
        [leadId], 'run'
      );

      const n = result.changes;
      logger.info(`[telegram] cancel_speed: cancelled ${n} scheduled followup(s) for lead ${leadId}`);

      if (n === 0) {
        await telegram.answerCallback(callbackId, 'No scheduled jobs found for this lead.');
      } else {
        await telegram.answerCallback(callbackId, `Speed sequence cancelled for this lead. ${n} job${n !== 1 ? 's' : ''} removed.`);
      }
    } catch (err) {
      logger.error('[telegram] cancel_speed error:', err);
      await telegram.answerCallback(callbackId, 'Error cancelling speed sequence.');
    }
  }
}

module.exports = { handleCallback };
