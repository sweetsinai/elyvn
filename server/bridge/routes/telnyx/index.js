/**
 * Telnyx webhook router.
 * Mounts: signature verification middleware + POST / (inbound SMS).
 */

const express = require('express');
const router = express.Router();

const { logger } = require('../../utils/logger');
const { verifyTelnyxSignature } = require('./middleware');
const { handleInboundSMS } = require('./handlers');

// Signature verification on all routes in this router
router.use(verifyTelnyxSignature);

// POST / — Telnyx SMS webhook
router.post('/', (req, res) => {
  try {
    const { data } = req.body || {};

    // Respond immediately — Telnyx expects a fast 200
    res.status(200).json({ success: true });

    const db = req.app.locals.db;
    if (!db) {
      logger.error('[sms] No database connection');
      return;
    }

    if (!data || !data.payload) {
      logger.warn('[sms] Missing data.payload in webhook');
      return;
    }

    const { payload } = data;

    if (!data.event_type || typeof data.event_type !== 'string') {
      logger.warn('[sms] Missing or invalid event_type in webhook');
      return;
    }

    if (!payload.direction || typeof payload.direction !== 'string') {
      logger.warn('[sms] Missing or invalid direction in webhook');
      return;
    }

    // Only process inbound messages
    if (data.event_type !== 'message.received' || payload.direction !== 'inbound') {
      logger.info(`[sms] Ignoring event_type: ${data.event_type}, direction: ${payload.direction}`);
      return;
    }

    const from = payload.from?.phone_number;
    const to = payload.to?.[0]?.phone_number;
    const body = payload.text;
    const messageId = payload.id;

    if (!from || typeof from !== 'string' || !to || typeof to !== 'string') {
      logger.warn('[sms] Missing or invalid from/to in SMS webhook');
      return;
    }

    if (from.length > 20 || to.length > 20) {
      logger.warn('[sms] Phone number exceeds length limit');
      return;
    }

    // Process async — response already sent
    setImmediate(() => {
      handleInboundSMS(db, { from, to, body, messageId }).catch(err => {
        logger.error('[sms] setImmediate error:', err);
      });
    });
  } catch (err) {
    logger.error('[sms] Webhook parsing error:', err);
    res.status(200).json({ success: false }); // Still 200 to prevent Telnyx retries
  }
});

module.exports = router;
