/**
 * White-Label Reseller API
 * Agencies can create sub-accounts, manage branding, and track their clients.
 */
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { logDataMutation } = require('../../utils/auditLog');
const { success, created } = require('../../utils/response');
const { hashPassword, createToken, verifyPassword, verifyToken } = require('../auth/utils');
const { validateBody } = require('../../middleware/validateRequest');
const { ResellerRegisterSchema, ResellerLoginSchema, ResellerCreateClientSchema } = require('../../utils/schemas/reseller');

// Brute-force protection for reseller login
const resellerLoginAttempts = new Map(); // ip+email -> { count, lockedUntil }
const RESELLER_LOGIN_MAX_ATTEMPTS = 5;
const RESELLER_LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Evict expired lockout entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of resellerLoginAttempts) {
    if (val.lockedUntil < now) resellerLoginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

// POST /reseller/register — Create a reseller account
router.post('/register', validateBody(ResellerRegisterSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { name, email, password, brand_name } = req.body;

    if (!name || !email || !password) {
      return next(new AppError('VALIDATION_ERROR', 'name, email, password required', 400));
    }
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      return next(new AppError('VALIDATION_ERROR', 'Invalid input types', 400));
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email) || email.length > 254) {
      return next(new AppError('VALIDATION_ERROR', 'Invalid email format', 400));
    }
    if (name.length > 200 || (brand_name && String(brand_name).length > 200)) {
      return next(new AppError('VALIDATION_ERROR', 'Name too long (max 200)', 400));
    }
    if (password.length < 8 || password.length > 128) return next(new AppError('VALIDATION_ERROR', 'Password must be 8-128 chars', 400));

    const existing = await db.query('SELECT id FROM resellers WHERE email = ?', [email.toLowerCase().trim()], 'get');
    if (existing) return next(new AppError('DUPLICATE', 'Email already registered', 409));

    const id = randomUUID();
    const passwordHash = await hashPassword(password);

    const now = new Date().toISOString();
    await db.query(`
      INSERT INTO resellers (id, name, email, password_hash, brand_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, name.trim(), email.toLowerCase().trim(), passwordHash, brand_name || name.trim(), now, now], 'run');

    const token = createToken({ resellerId: id, email: email.toLowerCase().trim(), role: 'reseller' });

    logger.info(`[reseller] New reseller registered: ${id}`);
    created(res, { token, reseller_id: id });
  } catch (err) {
    logger.error('[reseller] Register error:', err);
    next(err);
  }
});

// POST /reseller/login
router.post('/login', validateBody(ResellerLoginSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { email, password } = req.body;
    if (!email || !password) return next(new AppError('VALIDATION_ERROR', 'email and password required', 400));

    const attemptKey = `${req.ip}:${(email || '').toLowerCase()}`;
    const attempts = resellerLoginAttempts.get(attemptKey) || { count: 0, lockedUntil: 0 };
    if (Date.now() < attempts.lockedUntil) {
      const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
      return next(new AppError('RATE_LIMITED', `Too many failed attempts. Try again in ${remaining} minutes.`, 429));
    }

    const reseller = await db.query('SELECT id, email, password_hash, brand_name FROM resellers WHERE email = ? AND is_active = 1', [email.toLowerCase().trim()], 'get');
    if (!reseller) {
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= RESELLER_LOGIN_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + RESELLER_LOGIN_LOCKOUT_MS;
        attempts.count = 0;
        logger.warn(`[reseller] Account ${email} locked for 15 min after ${RESELLER_LOGIN_MAX_ATTEMPTS} failed attempts`);
      }
      resellerLoginAttempts.set(attemptKey, attempts);
      return next(new AppError('AUTH_FAILED', 'Invalid credentials', 401));
    }

    const valid = await verifyPassword(password, reseller.password_hash);
    if (!valid) {
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= RESELLER_LOGIN_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + RESELLER_LOGIN_LOCKOUT_MS;
        attempts.count = 0;
        logger.warn(`[reseller] Account ${email} locked for 15 min after ${RESELLER_LOGIN_MAX_ATTEMPTS} failed attempts`);
      }
      resellerLoginAttempts.set(attemptKey, attempts);
      return next(new AppError('AUTH_FAILED', 'Invalid credentials', 401));
    }

    resellerLoginAttempts.delete(attemptKey);

    const token = createToken({ resellerId: reseller.id, email: reseller.email, role: 'reseller' });
    success(res, { token, reseller_id: reseller.id, brand_name: reseller.brand_name });
  } catch (err) {
    logger.error('[reseller] Login error:', err);
    next(err);
  }
});

// Reseller auth middleware — verifies JWT token has matching resellerId
function requireReseller(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next(new AppError('AUTH_REQUIRED', 'Authentication required', 401));
  const payload = verifyToken(authHeader.slice(7));
  if (!payload || payload.role !== 'reseller') return next(new AppError('AUTH_FAILED', 'Invalid or expired token', 401));
  req.resellerId = payload.resellerId;
  next();
}

// GET /reseller/:resellerId/clients — List all clients under this reseller
router.get('/:resellerId/clients', requireReseller, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { resellerId } = req.params;
    if (!isValidUUID(resellerId)) return next(new AppError('INVALID_INPUT', 'Invalid reseller ID', 400));
    if (req.resellerId !== resellerId) return next(new AppError('FORBIDDEN', 'Access denied', 403));

    const clients = await db.query(
      `SELECT id, business_name, owner_email, plan, subscription_status, is_active, created_at
       FROM clients WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 500`,
      [resellerId], 'all'
    );

    success(res, { clients, count: clients.length });
  } catch (err) {
    logger.error('[reseller] Clients error:', err);
    next(err);
  }
});

// POST /reseller/:resellerId/create-client — Create a sub-account (white-label client)
router.post('/:resellerId/create-client', requireReseller, validateBody(ResellerCreateClientSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { resellerId } = req.params;
    const { business_name, owner_email, owner_phone, industry, owner_name } = req.body;

    if (!isValidUUID(resellerId)) return next(new AppError('INVALID_INPUT', 'Invalid reseller ID', 400));
    if (req.resellerId !== resellerId) return next(new AppError('FORBIDDEN', 'Access denied', 403));
    if (!business_name || !owner_email) return next(new AppError('VALIDATION_ERROR', 'business_name and owner_email required', 400));

    // Verify reseller exists
    const reseller = await db.query('SELECT id, brand_name FROM resellers WHERE id = ? AND is_active = 1', [resellerId], 'get');
    if (!reseller) return next(new AppError('NOT_FOUND', 'Reseller not found', 404));

    // Check email not already taken
    const existing = await db.query('SELECT id FROM clients WHERE owner_email = ?', [owner_email.toLowerCase().trim()], 'get');
    if (existing) return next(new AppError('DUPLICATE', 'Email already exists', 409));

    const clientId = randomUUID();
    await db.query(`
      INSERT INTO clients (id, name, business_name, owner_name, owner_email, owner_phone, industry,
                           reseller_id, white_label_brand, plan, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'trial', 1, ?, ?)
    `, [clientId, business_name.trim(), business_name.trim(), owner_name?.trim() || '',
        owner_email.toLowerCase().trim(), owner_phone?.trim() || '', industry || '',
        resellerId, reseller.brand_name, new Date().toISOString(), new Date().toISOString()], 'run');

    try { logDataMutation(db, { action: 'reseller_client_created', table: 'clients', recordId: clientId, newValues: { resellerId, business_name } }); } catch (_) {}

    logger.info(`[reseller] Client ${clientId} created by reseller ${resellerId}`);
    created(res, { client_id: clientId, business_name: business_name.trim() });
  } catch (err) {
    logger.error('[reseller] Create client error:', err);
    next(err);
  }
});

// GET /reseller/:resellerId/stats — Reseller dashboard stats
router.get('/:resellerId/stats', requireReseller, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { resellerId } = req.params;
    if (!isValidUUID(resellerId)) return next(new AppError('INVALID_INPUT', 'Invalid reseller ID', 400));
    if (req.resellerId !== resellerId) return next(new AppError('FORBIDDEN', 'Access denied', 403));

    const [clientCount, activeCount, revenue] = await Promise.all([
      db.query('SELECT COUNT(*) as c FROM clients WHERE reseller_id = ?', [resellerId], 'get'),
      db.query("SELECT COUNT(*) as c FROM clients WHERE reseller_id = ? AND is_active = 1 AND plan != 'trial'", [resellerId], 'get'),
      db.query(`
        SELECT COUNT(*) as paying,
          SUM(CASE WHEN plan = 'starter' THEN 199 WHEN plan = 'pro' THEN 399 WHEN plan = 'premium' THEN 799 ELSE 0 END) as mrr
        FROM clients WHERE reseller_id = ? AND subscription_status = 'active' AND plan IN ('starter','pro','premium')
      `, [resellerId], 'get'),
    ]);

    success(res, {
      total_clients: clientCount.c,
      active_paying: activeCount.c,
      monthly_revenue: revenue.mrr || 0,
      paying_clients: revenue.paying || 0,
    });
  } catch (err) {
    logger.error('[reseller] Stats error:', err);
    next(err);
  }
});

module.exports = router;
