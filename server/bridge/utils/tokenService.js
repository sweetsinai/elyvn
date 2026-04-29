/**
 * Token Service
 * Handles Access & Refresh Token generation, validation, and rotation.
 */
const { createToken, verifyToken } = require('../routes/auth/utils');
const { randomUUID, createHash } = require('crypto');
const { logger } = require('./logger');

const ACCESS_TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Generate a new set of tokens for a client.
 */
async function generateAuthTokens(db, clientId, payload = {}) {
  const accessToken = createToken({ ...payload, clientId, type: 'access' }, ACCESS_TOKEN_EXPIRY);
  
  // Generate opaque refresh token
  const refreshToken = randomUUID() + randomUUID();
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY).toISOString();
  
  await db.query(`
    INSERT INTO refresh_tokens (id, client_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `, [randomUUID(), clientId, tokenHash, expiresAt], 'run');
  
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRY };
}

/**
 * Rotate a refresh token: validates the old one and returns a new set.
 */
async function rotateRefreshToken(db, oldRefreshToken) {
  const tokenHash = createHash('sha256').update(oldRefreshToken).digest('hex');
  
  const stored = await db.query(`
    SELECT * FROM refresh_tokens 
    WHERE token_hash = ? AND revoked = 0 AND expires_at > DATETIME('now')
  `, [tokenHash], 'get');
  
  if (!stored) {
    logger.warn(`[auth] Invalid or expired refresh token attempt: ${tokenHash.slice(0, 8)}...`);
    // Detection of token reuse/theft: if we find a revoked token with this hash, 
    // it might be a replay attack. For now, just reject.
    throw new Error('INVALID_REFRESH_TOKEN');
  }
  
  // Revoke old token
  await db.query('UPDATE refresh_tokens SET revoked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [stored.id], 'run');
  
  // Generate new set
  return generateAuthTokens(db, stored.client_id, { email: stored.email }); // Note: need to pass email if needed
}

/**
 * Revoke all tokens for a client (e.g. on password change)
 */
async function revokeAllTokens(db, clientId) {
  await db.query('UPDATE refresh_tokens SET revoked = 1, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?', [clientId], 'run');
}

module.exports = { generateAuthTokens, rotateRefreshToken, revokeAllTokens };
