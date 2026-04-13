/**
 * Column-Level PII Encryption — AES-256-GCM
 *
 * Encrypts sensitive fields (phone, email, message body) at rest.
 * If ENCRYPTION_KEY env var is not set, operates in passthrough mode
 * so existing installs continue working without breaking.
 *
 * Format: base64(iv):base64(authTag):base64(ciphertext)
 */

const crypto = require('crypto');
const { logger } = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

// Derive 32-byte key from hex env var (or null for passthrough)
let _key = null;
const rawKey = process.env.ENCRYPTION_KEY;
if (rawKey) {
  try {
    const buf = Buffer.from(rawKey, 'hex');
    if (buf.length !== 32) {
      logger.error(`[encryption] ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${buf.length} bytes — passthrough mode`);
    } else {
      _key = buf;
      logger.info('[encryption] AES-256-GCM encryption enabled');
    }
  } catch (err) {
    logger.error('[encryption] Invalid ENCRYPTION_KEY hex — PII will NOT be encrypted');
  }
} else if (process.env.NODE_ENV === 'production') {
  logger.error('[encryption] ENCRYPTION_KEY is required in production — PII will NOT be encrypted');
}

// Pattern: three colon-separated base64 segments
const ENCRYPTED_RE = /^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/;

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns "iv:authTag:ciphertext" with each segment base64-encoded.
 * If no encryption key is configured, returns the plaintext unchanged (passthrough).
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  if (!_key || plaintext == null) return plaintext;
  if (typeof plaintext !== 'string') return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, _key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt an "iv:authTag:ciphertext" string back to plaintext.
 * If no encryption key is configured, or the value doesn't match the encrypted format,
 * returns the input unchanged (passthrough).
 *
 * @param {string} encrypted
 * @returns {string}
 */
function decrypt(encrypted) {
  if (!_key || encrypted == null) return encrypted;
  if (typeof encrypted !== 'string') return encrypted;
  if (!isEncrypted(encrypted)) return encrypted;

  try {
    const [ivB64, tagB64, dataB64] = encrypted.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, _key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

    return decrypted.toString('utf8');
  } catch (err) {
    logger.error('[encryption] Decryption failed:', err.message);
    return encrypted; // Return as-is on failure — don't lose data
  }
}

/**
 * Check whether a value matches the encrypted "iv:authTag:ciphertext" format.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (typeof value !== 'string') return false;
  return ENCRYPTED_RE.test(value);
}

module.exports = { encrypt, decrypt, isEncrypted };
