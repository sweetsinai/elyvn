/**
 * POST /auth/login
 */
const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { validateBody } = require('../../middleware/validateRequest');
const { LoginSchema } = require('../../utils/schemas/auth');
const timing = require('../../config/timing');
const { LRUCache } = require('lru-cache');
const { verifyPassword } = require('./utils');
const { generateAuthTokens } = require('../../utils/tokenService');
const { logAudit } = require('../../utils/auditLog');

const loginAttempts = new LRUCache({
  max: 5000,
  ttl: 3600000, // 1 hour
});
const LOGIN_MAX_ATTEMPTS = timing.LOGIN_MAX_ATTEMPTS || 10;
const LOGIN_LOCKOUT_MS = timing.LOGIN_LOCKOUT_MS || 900000;



router.post('/', validateBody(LoginSchema), async (req, res, next) => {
  const db = req.app.locals.db;
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new AppError('MISSING_FIELD', 'email and password are required', 400));
  }

  const attemptKey = `${req.ip}:${(email || '').toLowerCase()}`;
  const attempts = loginAttempts.get(attemptKey) || { count: 0, lockedUntil: 0 };
  if (Date.now() < attempts.lockedUntil) {
    const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
    return next(new AppError('RATE_LIMITED', `Too many failed attempts. Try again in ${remaining} minutes.`, 429));
  }

  try {
    const client = await db.query(
      'SELECT id, business_name, owner_email, password_hash, plan, subscription_status FROM clients WHERE owner_email = ?',
      [email.toLowerCase().trim()],
      'get'
    );

    if (!client || !client.password_hash) {
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        attempts.count = 0;
        logger.warn(`[auth] Account ${email} locked for 15 min after ${LOGIN_MAX_ATTEMPTS} failed attempts`);
      }
      loginAttempts.set(attemptKey, attempts);
      logAudit(db, { action: 'auth_failure', ip: req.ip, details: { reason: 'account_not_found', email } }).catch(() => {});
      return next(new AppError('UNAUTHORIZED', 'Invalid email or password', 401));
    }

    if (!await verifyPassword(password, client.password_hash)) {
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        attempts.count = 0;
        logger.warn(`[auth] Account ${email} locked for 15 min after ${LOGIN_MAX_ATTEMPTS} failed attempts`);
      }
      loginAttempts.set(attemptKey, attempts);
      logAudit(db, { action: 'auth_failure', ip: req.ip, details: { reason: 'invalid_password', email } }).catch(() => {});
      return next(new AppError('UNAUTHORIZED', 'Invalid email or password', 401));
    }

    loginAttempts.delete(attemptKey);

    const { accessToken, refreshToken, expiresIn } = await generateAuthTokens(db, client.id, { email: client.owner_email });

    logAudit(db, { action: 'auth_success', ip: req.ip, clientId: client.id, details: { email } }).catch(() => {});
    logger.info(`[auth] Login: ${email} → client ${client.id}`);
    res.json({
      token: accessToken,
      refreshToken,
      expiresIn,
      clientId: client.id,
      email: client.owner_email,
      business_name: client.business_name,
      plan: client.plan || 'trial',
      subscription_status: client.subscription_status || 'active',
    });
  } catch (err) {
    logger.error('[auth] Login error:', {
      message: err.message,
      stack: err.stack,
      email: email,
      ip: req.ip
    });
    
    // If it's a database-related error and we're starting up, return 503
    if (!req.app.locals.db || err.message.includes('query')) {
      return next(new AppError('SERVICE_UNAVAILABLE', 'System is still initializing. Please try again in a few seconds.', 503));
    }

    const message = process.env.NODE_ENV === 'production' ? 'Login failed' : `Login failed: ${err.message}`;
    return next(new AppError('INTERNAL_ERROR', message, 500));
  }
});

module.exports = router;
