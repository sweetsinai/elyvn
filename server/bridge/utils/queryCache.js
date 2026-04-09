// Simple TTL-based in-memory cache for read queries
const cache = new Map();
const MAX_CACHE_SIZE = 1000;
const insertionOrder = []; // track insertion order for eviction

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs = 30000) {
  // Evict oldest entries when over max size
  if (!cache.has(key) && cache.size >= MAX_CACHE_SIZE) {
    while (insertionOrder.length > 0 && cache.size >= MAX_CACHE_SIZE) {
      const oldest = insertionOrder.shift();
      cache.delete(oldest);
    }
  }
  if (!cache.has(key)) {
    insertionOrder.push(key);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function invalidate(pattern) {
  // Delete all keys matching pattern (e.g., 'leads:*')
  for (const key of cache.keys()) {
    if (key.startsWith(pattern)) cache.delete(key);
  }
}

function size() { return cache.size; }

// Periodic eviction of expired entries (every 60s)
const _evictionInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now > entry.expiresAt) {
      cache.delete(key);
    }
  }
}, 60000);
_evictionInterval.unref();

module.exports = { get, set, invalidate, size };
