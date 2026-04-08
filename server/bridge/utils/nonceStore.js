/**
 * Nonce deduplication store — Redis-backed with in-memory LRU fallback.
 *
 * If REDIS_URL is set and ioredis is installed, nonces are stored in Redis
 * with automatic TTL expiry.  Otherwise falls back to a bounded in-memory
 * Map (LRU eviction at 10 000 entries).
 */

const { logger } = require('./logger');

const MAX_MEMORY_ENTRIES = 10000;

// ---------------------------------------------------------------------------
// In-memory fallback (Map with insertion-order iteration for LRU eviction)
// ---------------------------------------------------------------------------
const memStore = new Map(); // key -> expiresAtMs

function memHas(key) {
  const exp = memStore.get(key);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    memStore.delete(key);
    return false;
  }
  return true;
}

function memAdd(key, ttlSeconds) {
  // Evict oldest entries when over capacity
  while (memStore.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memStore.keys().next().value;
    memStore.delete(oldest);
  }
  memStore.set(key, Date.now() + ttlSeconds * 1000);
}

// ---------------------------------------------------------------------------
// Redis adapter (lazy-initialised)
// ---------------------------------------------------------------------------
let redis = null;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    redis.connect().catch((err) => {
      logger.warn('[nonceStore] Redis connect failed, falling back to memory:', err.message);
      redis = null;
    });
    redis.on('error', (err) => {
      logger.warn('[nonceStore] Redis error:', err.message);
    });
  } catch (err) {
    // ioredis not installed — stay with in-memory
    logger.info('[nonceStore] ioredis not installed, using in-memory store');
    redis = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a nonce has already been seen.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function hasNonce(key) {
  if (redis) {
    try {
      const exists = await redis.exists(`nonce:${key}`);
      return exists === 1;
    } catch (err) {
      logger.warn('[nonceStore] Redis EXISTS failed, falling back to memory:', err.message);
    }
  }
  return memHas(key);
}

/**
 * Mark a nonce as seen.
 * @param {string} key
 * @param {number} ttlSeconds  How long before the nonce expires (default 3600).
 * @returns {Promise<void>}
 */
async function addNonce(key, ttlSeconds = 3600) {
  if (redis) {
    try {
      // SET NX EX — only sets if not exists, with TTL
      await redis.set(`nonce:${key}`, '1', 'EX', ttlSeconds, 'NX');
      return;
    } catch (err) {
      logger.warn('[nonceStore] Redis SET failed, falling back to memory:', err.message);
    }
  }
  memAdd(key, ttlSeconds);
}

module.exports = { hasNonce, addNonce };
