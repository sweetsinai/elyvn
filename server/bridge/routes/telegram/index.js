'use strict';

const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { handleCommand } = require('./commands');
const { handleCallback } = require('./callbacks');

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
    handleCommand(db, update.message).catch(err => logger.error('Telegram command error:', err));
  } else if (update.callback_query) {
    handleCallback(db, update.callback_query).catch(err => logger.error('Telegram callback error:', err));
  }
});

module.exports = router;
