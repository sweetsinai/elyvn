'use strict';

const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { handleCommand } = require('./commands');
const { handleCallback } = require('./callbacks');
const telegram = require('../../utils/telegram');

/**
 * Handle two-way reply: owner replies to a "Reply to +1XXXXXXXXXX" prompt.
 * Extracts the phone number from the original prompt message, sends the
 * owner's text as an SMS to that phone number.
 */
async function handleReply(db, message) {
  const chatId = String(message.chat.id);
  const ownerText = (message.text || '').trim();
  const promptText = message.reply_to_message?.text || '';

  // Extract phone number from "Reply to +1XXXXXXXXXX" format
  const phoneMatch = promptText.match(/Reply to (\+?\d[\d\s-]+)/);
  if (!phoneMatch || !ownerText) {
    await telegram.sendMessage(chatId, 'Could not identify the lead phone number. Use /leads to find them.');
    return;
  }

  const phone = phoneMatch[1].replace(/[\s-]/g, '');

  // Find the client linked to this Telegram chat
  const client = await db.query(
    'SELECT id, twilio_phone, telnyx_phone, business_name FROM clients WHERE telegram_chat_id = ?',
    [chatId], 'get'
  );
  if (!client) {
    await telegram.sendMessage(chatId, 'No linked ELYVN account. Use /start to connect.');
    return;
  }

  // SECURITY: Verify this phone number belongs to an actual lead for this client
  const lead = await db.query(
    'SELECT id FROM leads WHERE client_id = ? AND phone = ?',
    [client.id, phone], 'get'
  );
  if (!lead) {
    const maskedPhone = phone.replace(/\d(?=\d{4})/g, '*');
    await telegram.sendMessage(chatId, `No lead found with that number. Cannot send.`);
    logger.warn(`[telegram] Reply blocked — phone ${phone.replace(/\d(?=\d{4})/g, '*')} not found in leads for client ${client.id}`);
    return;
  }

  try {
    const { sendSMS } = require('../../utils/sms');
    const fromPhone = client.twilio_phone || client.telnyx_phone;
    await sendSMS(phone, ownerText, fromPhone, db, client.id);

    const escaped = ownerText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safePhone = phone.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await telegram.sendMessage(chatId, `&#9989; <b>Sent to ${safePhone}:</b>\n${escaped}`);
    logger.info(`[telegram] Owner reply sent via SMS to ${phone.replace(/\d(?=\d{4})/g, '*')} for client ${client.id}`);
  } catch (err) {
    logger.error('[telegram] Reply SMS failed:', err.message);
    await telegram.sendMessage(chatId, `&#10060; Failed to send SMS. Please try again or check your Twilio configuration.`);
  }
}

// Verify webhook secret (skip if not configured)
router.use((req, res, next) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[telegram] TELEGRAM_WEBHOOK_SECRET not configured in production');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    return next();
  }
  if (expectedSecret) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (!secret) {
      return res.sendStatus(403);
    }
    // Use timing-safe comparison to prevent timing attacks
    try {
      const crypto = require('crypto');
      if (secret.length === expectedSecret.length) {
        if (!crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expectedSecret))) {
          return res.sendStatus(403);
        }
      } else {
        // Different lengths — fail securely
        return res.sendStatus(403);
      }
    } catch (err) {
      // Comparison error — fail closed
      return res.sendStatus(403);
    }
  }
  next();
});

router.post('/', (req, res) => {
  res.sendStatus(200);

  const db = req.app.locals.db;
  if (!db) {
    logger.error('[telegram] No database connection');
    return;
  }
  const update = req.body || {};

  if (update.message) {
    // Check if this is a reply to a "Reply to +phone" prompt (two-way reply feature)
    if (update.message.reply_to_message?.text?.startsWith('Reply to ')) {
      handleReply(db, update.message).catch(err => logger.error('Telegram reply error:', err));
    } else {
      handleCommand(db, update.message).catch(err => logger.error('Telegram command error:', err));
    }
  } else if (update.callback_query) {
    handleCallback(db, update.callback_query).catch(err => logger.error('Telegram callback error:', err));
  }
});

module.exports = router;
