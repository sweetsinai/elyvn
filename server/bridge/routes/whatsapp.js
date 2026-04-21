/**
 * WhatsApp Webhook Handler (via Twilio WhatsApp Business API)
 *
 * Twilio sends WhatsApp messages to the same webhook endpoint as SMS,
 * but phone numbers are prefixed with "whatsapp:".
 *
 * Setup:
 * 1. Enable WhatsApp on a Twilio number (or use Twilio Sandbox for testing)
 * 2. Set webhook URL: https://your-domain.com/webhooks/whatsapp
 * 3. Add TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX to env
 *
 * Clients opt in to WhatsApp by texting your Twilio sandbox number
 * or via approved WhatsApp Business templates.
 */

const express = require('express');
const router = express.Router();
const { createHmac, timingSafeEqual } = require('crypto');
const { logger } = require('../utils/logger');
const { handleInboundSMS } = require('./legacySms/handlers');

// Twilio request validation (same as regular SMS webhook)
function verifyTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  // In dev without auth token, skip validation
  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[whatsapp] TWILIO_AUTH_TOKEN not set in production — rejecting');
      return res.status(403).json({ error: 'Not configured' });
    }
    logger.warn('[whatsapp] Signature validation skipped (TWILIO_AUTH_TOKEN not set)');
    return next();
  }

  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) {
    logger.warn('[whatsapp] Missing x-twilio-signature header');
    return res.status(403).json({ error: 'Missing signature' });
  }

  // Reconstruct the URL and build the expected signature
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const url = `${baseUrl}/webhooks/whatsapp`;

  // Build the string to sign: URL + sorted POST params concatenated
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  const sigStr = url + sortedKeys.map(k => k + params[k]).join('');

  const expected = createHmac('sha1', authToken).update(Buffer.from(sigStr, 'utf-8')).digest('base64');
  try {
    const sigBuf = Buffer.from(twilioSignature, 'base64');
    const expBuf = Buffer.from(expected, 'base64');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('[whatsapp] Invalid Twilio signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }
  } catch {
    return res.status(403).json({ error: 'Signature verification failed' });
  }

  next();
}

// POST /webhooks/whatsapp — Twilio WhatsApp inbound message
router.post('/', verifyTwilioSignature, (req, res) => {
  // Always respond 200 fast (Twilio will retry if we don't)
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  const db = req.app.locals.db;
  if (!db) return;

  try {
    const { From, To, Body, MessageSid, NumMedia } = req.body || {};

    if (!From || !To) {
      logger.warn('[whatsapp] Missing From/To in webhook');
      return;
    }

    // Strip the "whatsapp:" prefix — normalize to E.164 phone numbers
    const from = From.replace(/^whatsapp:/i, '');
    const to = To.replace(/^whatsapp:/i, '');
    const body = Body || '';
    const messageId = MessageSid;

    // Log media count if message has attachments (future: handle images)
    if (parseInt(NumMedia || '0') > 0) {
      logger.info(`[whatsapp] Message from ${from.replace(/\d(?=\d{4})/g, '*')} includes ${NumMedia} media attachments (not yet processed)`);
    }

    logger.info(`[whatsapp] Inbound WhatsApp from ${from.replace(/\d(?=\d{4})/g, '*')} to ${to}`);

    // Reuse the exact same SMS handling logic — brain, opt-outs, stage updates, etc.
    setImmediate(() => {
      handleInboundSMS(db, { from, to, body, messageId }).catch(err => {
        logger.error('[whatsapp] Handler error:', err.message);
      });
    });
  } catch (err) {
    logger.error('[whatsapp] Webhook parsing error:', err.message);
  }
});

module.exports = router;
