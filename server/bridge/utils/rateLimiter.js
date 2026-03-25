/**
 * Bounded Rate Limiter
 * Per-IP rate limiting with LRU eviction to prevent memory leaks.
 * Supports per-client limits via client_api_keys table.
 */

class BoundedRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60 * 1000;
    this.maxRequests = options.maxRequests || 120;
    this.maxEntries = options.maxEntries || 10000;
    this.entries = new Map(); // key → { count, windowStart, lastAccess }
  }

  check(key) {
    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now, lastAccess: now });
      this._evictIfNeeded();
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + this.windowMs };
    }

    entry.count++;
    entry.lastAccess = now;

    if (entry.count > this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.windowStart + this.windowMs, retryAfter: Math.ceil((entry.windowStart + this.windowMs - now) / 1000) };
    }

    return { allowed: true, remaining: this.maxRequests - entry.count, resetAt: entry.windowStart + this.windowMs };
  }

  _evictIfNeeded() {
    if (this.entries.size <= this.maxEntries) return;

    // Evict oldest entries (LRU)
    let oldest = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldest = key;
      }
    }
    if (oldest) this.entries.delete(oldest);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.entries.delete(key);
      }
    }
  }

  get size() { return this.entries.size; }
}

module.exports = { BoundedRateLimiter };
