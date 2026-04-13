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
const { verifyPassword, createToken } = require('./utils');
const { logAudit } = require('../../utils/auditLog');

const loginAttempts = new Map(); // ip+email -> { count, lockedUntil }
const LOGIN_MAX_ATTEMPTS = timing.LOGIN_MAX_ATTEMPTS;
const LOGIN_LOCKOUT_MS = timing.LOGIN_LOCKOUT_MS;

// Evict expired lockout entries every 10 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts) {
    if (val.lockedUntil < now) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

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

    const token = createToken({ clientId: client.id, email: client.owner_email });

    logAudit(db, { action: 'auth_success', ip: req.ip, clientId: client.id, details: { email } }).catch(() => {});
    logger.info(`[auth] Login: ${email} → client ${client.id}`);
    res.json({
      token,
      clientId: client.id,
      email: client.owner_email,
      business_name: client.business_name,
      plan: client.plan || 'trial',
      subscription_status: client.subscription_status || 'active',
    });
  } catch (err) {
    logger.error('[auth] Login error:', err.message);
    return next(new AppError('INTERNAL_ERROR', 'Login failed', 500));
  }
});

module.exports = router;
