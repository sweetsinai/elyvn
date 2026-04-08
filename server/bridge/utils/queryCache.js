// Simple TTL-based in-memory cache for read queries
const cache = new Map();

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
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function invalidate(pattern) {
  // Delete all keys matching pattern (e.g., 'leads:*')
  for (const key of cache.keys()) {
    if (key.startsWith(pattern)) cache.delete(key);
  }
}

function size() { return cache.size; }

module.exports = { get, set, invalidate, size };
