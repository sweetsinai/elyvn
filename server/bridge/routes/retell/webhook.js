'use strict';

/**
 * webhook.js — Retell webhook entry point
 *
 * Owns: HMAC signature verification middleware, POST / dispatcher,
 *       nonce/replay prevention.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../../utils/logger');
const { hasNonce, addNonce } = require('../../utils/nonceStore');
const { AppError } = require('../../utils/AppError');

const {
  handleCallStarted,
  handleCallEnded,
  handleCallAnalyzed,
  handleTransfer,
} = require('./calls');

// HMAC signature verification (timing-safe)
router.use((req, res, next) => {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[retell] RETELL_WEBHOOK_SECRET not set in production — rejecting webhook');
      return next(new AppError('SERVER_ERROR', 'Webhook verification not configured', 500));
    }
    return next();
  }
  const signature = req.headers['x-retell-signature'];
  if (!signature) {
    logger.warn('[retell] Missing webhook signature header');
    return next(new AppError('MISSING_SIGNATURE', 'Missing signature', 401));
  }
  const payload = req.rawBody || JSON.stringify(req.body);
  const expected = require('crypto').createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !require('crypto').timingSafeEqual(sigBuf, expBuf)) {
    logger.warn('[retell] Invalid webhook signature');
    return next(new AppError('INVALID_SIGNATURE', 'Invalid signature', 401));
  }
  next();
});

// POST / — handles all Retell webhook events
router.post('/', async (req, res) => {
  const body = req.body || {};
  const event = body.event;
  const call = body.call || {};

  const correlationId = req.headers['x-request-id'] ||
    body.call_id || (call && call.call_id) ||
    crypto.randomUUID();

  // Nonce / replay prevention
  const webhookNonce = `${body.call_id || (call && call.call_id) || ''}-${event || req.path}`;
  if (webhookNonce && webhookNonce !== '-') {
    if (await hasNonce(webhookNonce)) {
      logger.warn(`[retell] Duplicate webhook rejected: ${webhookNonce}`, { correlationId });
      return res.status(200).json({ received: true });
    }
    await addNonce(webhookNonce, 3600);
  }

  res.status(200).json({ received: true });

  if (!event) {
    logger.info('[retell] No event in payload', { correlationId });
    return;
  }

  const db = req.app.locals.db;
  if (!db) {
    logger.error('[retell] No database connection', { correlationId });
    return;
  }

  setImmediate(async () => {
    try {
      switch (event) {
        case 'call_started':
          await handleCallStarted(db, call, correlationId);
          break;
        case 'call_ended':
          await handleCallEnded(db, call, correlationId);
          break;
        case 'call_analyzed':
          await handleCallAnalyzed(db, call, correlationId);
          break;
        case 'agent_transfer':
        case 'transfer_requested':
          await handleTransfer(db, call, correlationId);
          break;
        case 'dtmf':
          if (call && call.digit === '*') await handleTransfer(db, call, correlationId);
          break;
        default:
          logger.info(`[retell] Unhandled event: ${event}`, { correlationId });
      }
    } catch (err) {
      logger.error('[retell] Processing error', { correlationId, code: 'PROCESSING_ERROR', event, callId: call?.call_id, error: err.message, stack: err.stack });
    }
  });
});

module.exports = router;
