/**
 * Authentication routes — JWT-based signup/login for ELYVN dashboard
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const loginAttempts = new Map(); // ip+email -> { count, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Simple password hashing using Node.js built-in scrypt (no bcrypt dependency needed)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
}

// Simple JWT using HMAC-SHA256 (no jsonwebtoken dependency needed)
// SECURITY: JWT_SECRET must be set in production.
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.ELYVN_API_KEY && process.env.ELYVN_API_KEY.length >= 32) {
    logger.warn('[auth] WARNING: JWT_SECRET not set — falling back to ELYVN_API_KEY. Set JWT_SECRET explicitly.');
    return process.env.ELYVN_API_KEY;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[auth] FATAL: JWT_SECRET must be set in production — server cannot start safely');
  }
  logger.warn('[auth] WARNING: JWT_SECRET not set — using fixed dev-only secret. NEVER use this in production!');
  return 'elyvn-dev-secret-do-not-use-in-production';
})();
const JWT_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

const JWT_ISSUER = 'elyvn-api';
const JWT_AUDIENCE = 'elyvn-dashboard';

function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Date.now();
  const data = { ...payload, iat: now, exp: now + JWT_EXPIRY, iss: JWT_ISSUER, aud: JWT_AUDIENCE };
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    if (!header || !body || !sig) return null;

    // Reject 'none' algorithm attack
    try {
      const hdr = JSON.parse(Buffer.from(header, 'base64url').toString());
      if (hdr.alg !== 'HS256') return null;
    } catch { return null; }

    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');

    // Timing-safe comparison: ensure equal length before comparing
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!payload.clientId) return null;
    if (payload.iss !== JWT_ISSUER) return null;
    if (payload.aud !== JWT_AUDIENCE) return null;
    return payload;
  } catch { return null; }
}

// POST /auth/signup
router.post('/signup', (req, res) => {
  const db = req.app.locals.db;
  const { email, password, business_name, owner_name, owner_phone } = req.body;

  if (!email || !password || !business_name) {
    return res.status(400).json({ error: 'email, password, and business_name are required' });
  }
  if (typeof email !== 'string' || typeof password !== 'string' || typeof business_name !== 'string') {
    return res.status(400).json({ error: 'Invalid input types' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 8-128 characters' });
  }
  if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
    return res.status(400).json({ error: 'Password must contain at least one letter and one number' });
  }
  if (email.length > 254 || business_name.length > 200) {
    return res.status(400).json({ error: 'Input too long' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Check if email already exists
  const existing = db.prepare('SELECT id FROM clients WHERE owner_email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  try {
    const clientId = crypto.randomUUID();
    const passwordHash = hashPassword(password);

    db.prepare(`
      INSERT INTO clients (id, name, owner_name, owner_email, owner_phone, password_hash, is_active, plan, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'trial', datetime('now'), datetime('now'))
    `).run(clientId, business_name.trim(), owner_name?.trim() || '', email.toLowerCase().trim(), owner_phone?.trim() || '', passwordHash);

    const token = createToken({ clientId, email: email.toLowerCase().trim() });

    logger.info(`[auth] New signup: ${email} → client ${clientId}`);
    res.status(201).json({
      token,
      clientId,
      email: email.toLowerCase().trim(),
      business_name: business_name.trim(),
    });
  } catch (err) {
    logger.error('[auth] Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /auth/login
router.post('/login', (req, res) => {
  const db = req.app.locals.db;
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const attemptKey = `${req.ip}:${(email || '').toLowerCase()}`;
  const attempts = loginAttempts.get(attemptKey) || { count: 0, lockedUntil: 0 };
  if (Date.now() < attempts.lockedUntil) {
    const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${remaining} minutes.` });
  }

  try {
    const client = db.prepare('SELECT id, name, owner_email, password_hash, plan, subscription_status FROM clients WHERE owner_email = ?')
      .get(email.toLowerCase().trim());

    if (!client || !client.password_hash) {
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        attempts.count = 0;
        logger.warn(`[auth] Account ${email} locked for 15 min after ${LOGIN_MAX_ATTEMPTS} failed attempts`);
      }
      loginAttempts.set(attemptKey, attempts);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!verifyPassword(password, client.password_hash)) {
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        attempts.count = 0;
        logger.warn(`[auth] Account ${email} locked for 15 min after ${LOGIN_MAX_ATTEMPTS} failed attempts`);
      }
      loginAttempts.set(attemptKey, attempts);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    loginAttempts.delete(attemptKey);

    const token = createToken({ clientId: client.id, email: client.owner_email });

    logger.info(`[auth] Login: ${email} → client ${client.id}`);
    res.json({
      token,
      clientId: client.id,
      email: client.owner_email,
      business_name: client.name,
      plan: client.plan || 'trial',
      subscription_status: client.subscription_status || 'active',
    });
  } catch (err) {
    logger.error('[auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /auth/me — get current user from JWT
router.get('/me', (req, res) => {
  const db = req.app.locals.db;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const client = db.prepare('SELECT id, name, owner_name, owner_email, owner_phone, plan, subscription_status, stripe_customer_id, industry, created_at FROM clients WHERE id = ?')
      .get(payload.clientId);

    if (!client) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json({
      clientId: client.id,
      email: client.owner_email,
      business_name: client.name,
      owner_name: client.owner_name,
      plan: client.plan || 'trial',
      subscription_status: client.subscription_status || 'active',
      industry: client.industry,
      created_at: client.created_at,
    });
  } catch (err) {
    logger.error('[auth] /me error:', err.message);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// POST /auth/refresh — issue a new token before the current one expires
router.post('/refresh', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const newToken = createToken({ clientId: payload.clientId, email: payload.email });
  res.json({ token: newToken });
});

// Export token utilities for use in other middleware
module.exports = router;
module.exports.verifyToken = verifyToken;
module.exports.createToken = createToken;
