/**
 * GET  /auth/verify-email        — verify email address via token link
 * POST /auth/resend-verification — resend verification email (requires auth)
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { sendVerificationEmail } = require('../../utils/verificationEmail');
const config = require('../../utils/config');
const timing = require('../../config/timing');
const { verifyToken } = require('./utils');

const resendCooldowns = new Map(); // clientId -> lastSentAt
const RESEND_COOLDOWN_MS = timing.RESEND_VERIFICATION_COOLDOWN_MS;

// Cleanup expired cooldown entries every 5 minutes
const _cooldownCleanup = setInterval(() => {
  const now = Date.now();
  for (const [clientId, lastSent] of resendCooldowns.entries()) {
    if (now - lastSent >= RESEND_COOLDOWN_MS) {
      resendCooldowns.delete(clientId);
    }
  }
}, 5 * 60 * 1000);
_cooldownCleanup.unref();

// GET /auth/verify-email?token=xxx
router.get('/verify-email', async (req, res, next) => {
  const db = req.app.locals.db;
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return next(new AppError('MISSING_FIELD', 'Verification token is required', 400));
  }

  try {
    const client = await db.query(
      'SELECT id, verification_token, verification_expires, email_verified FROM clients WHERE verification_token = ?',
      [token],
      'get'
    );

    if (!client) {
      return next(new AppError('INVALID_INPUT', 'Invalid verification token', 400));
    }

    if (client.email_verified === 1) {
      const baseUrl = config.getBaseUrl();
      return res.redirect(`${baseUrl}/dashboard?verified=already`);
    }

    if (client.verification_expires && new Date(client.verification_expires) < new Date()) {
      return next(new AppError('VALIDATION_ERROR', 'Verification token has expired. Please request a new one.', 400));
    }

    await db.query(
      'UPDATE clients SET email_verified = 1, verification_token = NULL, verification_expires = NULL, updated_at = datetime(\'now\') WHERE id = ?',
      [client.id],
      'run'
    );

    logger.info(`[auth] Email verified for client ${client.id}`);

    const baseUrl = config.getBaseUrl();
    return res.redirect(`${baseUrl}/dashboard?verified=success`);
  } catch (err) {
    logger.error('[auth] Email verification error:', err.message);
    return next(new AppError('INTERNAL_ERROR', 'Verification failed', 500));
  }
});

// POST /auth/resend-verification
router.post('/resend-verification', async (req, res, next) => {
  const db = req.app.locals.db;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError('UNAUTHORIZED', 'No token provided', 401));
  }

  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return next(new AppError('UNAUTHORIZED', 'Invalid or expired token', 401));
  }

  try {
    const client = await db.query(
      'SELECT id, owner_email, email_verified FROM clients WHERE id = ?',
      [payload.clientId],
      'get'
    );

    if (!client) {
      return next(new AppError('NOT_FOUND', 'Account not found', 404));
    }

    if (client.email_verified === 1) {
      return next(new AppError('VALIDATION_ERROR', 'Email is already verified', 400));
    }

    // Rate limit: 1 per cooldown window
    const lastSent = resendCooldowns.get(client.id);
    if (lastSent && Date.now() - lastSent < RESEND_COOLDOWN_MS) {
      const remaining = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastSent)) / 60000);
      return next(new AppError('RATE_LIMITED', `Please wait ${remaining} minute(s) before requesting another verification email`, 429));
    }

    const newToken = crypto.randomBytes(32).toString('hex');
    const newExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await db.query(
      'UPDATE clients SET verification_token = ?, verification_expires = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [newToken, newExpires, client.id],
      'run'
    );

    resendCooldowns.set(client.id, Date.now());

    const baseUrl = config.getBaseUrl();
    sendVerificationEmail(client.owner_email, newToken, baseUrl).catch(err => {
      logger.error('[auth] Failed to resend verification email:', err.message);
    });

    logger.info(`[auth] Verification email resent for client ${client.id}`);
    res.json({ message: 'Verification email sent' });
  } catch (err) {
    logger.error('[auth] Resend verification error:', err.message);
    return next(new AppError('INTERNAL_ERROR', 'Failed to resend verification email', 500));
  }
});

module.exports = router;
