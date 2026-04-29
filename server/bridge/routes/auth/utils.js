/**
 * Shared crypto/JWT utilities for auth routes
 */
const crypto = require('crypto');
const { randomBytes, timingSafeEqual } = crypto;
const { promisify } = require('util');
const scryptAsync = promisify(require('crypto').scrypt);
const { logger } = require('../../utils/logger');

// Simple password hashing using Node.js built-in scrypt (no bcrypt dependency needed)
async function hashPassword(password) {
  const salt = randomBytes(32).toString('hex');
  const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expectedBuf = Buffer.from(expected, 'hex');
  if (hash.length !== expectedBuf.length) return false;
  return timingSafeEqual(hash, expectedBuf);
}

// Simple JWT using HMAC-SHA256 (no jsonwebtoken dependency needed)
// SECURITY: JWT_SECRET must be set.
const JWT_SECRET = process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET must be set'); })();

const JWT_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const JWT_ISSUER = 'elyvn-api';
const JWT_AUDIENCE = 'elyvn-dashboard';

function createToken(payload, expiryMs = JWT_EXPIRY) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Date.now();
  const data = { ...payload, iat: now, exp: now + expiryMs, iss: JWT_ISSUER, aud: JWT_AUDIENCE };
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
    if (!payload.clientId && !payload.resellerId) return null;
    if (payload.iss !== JWT_ISSUER) return null;
    if (payload.aud !== JWT_AUDIENCE) return null;
    return payload;
  } catch { return null; }
}

module.exports = { hashPassword, verifyPassword, createToken, verifyToken };
