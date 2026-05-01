/**
 * Twilio Inbound SMS Webhook Handler
 *
 * Routes through the same AI pipeline as Legacy SMS (brain, scoring, guardrails).
 * Twilio sends form-encoded POST (not JSON).
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger, withCorrelationId } = require('../utils/logger');
const { handleInboundSMS } = require('./legacySms/handlers');
const { randomUUID } = require('crypto');

/**
 * Validate Twilio request signature (X-Twilio-Signature)
 */
function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[twilio] TWILIO_AUTH_TOKEN not set in production — rejecting');
      return false;
    }
    return true;
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    logger.warn('[twilio] Missing X-Twilio-Signature header');
    return false;
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;

  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  const sigBuf = Buffer.from(signature, 'base64');
  const expectedBuf = Buffer.from(expected, 'base64');
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// Twilio sends application/x-www-form-urlencoded
router.use(express.urlencoded({ extended: false }));

router.post('/', (req, res) => {
  const db = req.app.locals.db;

  if (!validateTwilioSignature(req)) {
    logger.warn('[twilio] Invalid signature — rejecting');
    return res.status(403).send('<Response></Response>');
  }

  const from = req.body?.From;
  const to = req.body?.To;
  const body = req.body?.Body || '';
  const messageSid = req.body?.MessageSid;

  const correlationId = req.headers['x-request-id'] || messageSid || crypto.randomUUID();

  if (!from || !to) {
    logger.warn('[twilio] Missing From/To in webhook', { correlationId });
    return res.status(400).send('<Response></Response>');
  }

  // Respond immediately with empty TwiML
  res.set('Content-Type', 'text/xml');
  res.set('X-Correlation-ID', correlationId);
  res.send('<Response></Response>');

  if (!db) return;

  logger.info(`[twilio] Inbound SMS from ${from.replace(/\d(?=\d{4})/g, '*')} to ${to}`, { correlationId });

  // Route through the unified SMS pipeline (same as Legacy SMS)
  // This gives us: brain decisions, lead scoring, guardrails, rate limiting,
  // opt-out checking, Telegram notifications, usage tracking — everything.
  setImmediate(() => {
    withCorrelationId(correlationId, () => {
      handleInboundSMS(db, { from, to, body, messageId: messageSid }).catch(err => {
        logger.error('[twilio] Handler error:', err.message);
      });
    });
  });
});

module.exports = router;
