/**
 * Authentication routes — JWT-based signup/login for ELYVN dashboard
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../utils/logger');

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
const JWT_SECRET = process.env.JWT_SECRET || process.env.ELYVN_API_KEY || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Date.now();
  const data = { ...payload, iat: now, exp: now + JWT_EXPIRY };
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
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
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
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

  try {
    const client = db.prepare('SELECT id, name, owner_email, password_hash, plan, subscription_status FROM clients WHERE owner_email = ?')
      .get(email.toLowerCase().trim());

    if (!client || !client.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!verifyPassword(password, client.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

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

// Export token utilities for use in other middleware
module.exports = router;
module.exports.verifyToken = verifyToken;
module.exports.createToken = createToken;
