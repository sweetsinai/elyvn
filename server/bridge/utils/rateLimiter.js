const { LRUCache } = require('lru-cache');

class BoundedRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60 * 1000;
    this.maxRequests = options.maxRequests || 120;
    this.maxEntries = options.maxEntries || 10000;
    
    this.cache = new LRUCache({
      max: this.maxEntries,
      ttl: this.windowMs,
    });
  }

  check(key) {
    const now = Date.now();
    let entry = this.cache.get(key);

    if (!entry) {
      entry = { count: 1, windowStart: now };
      this.cache.set(key, entry);
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + this.windowMs };
    }

    entry.count++;

    if (entry.count > this.maxRequests) {
      return { 
        allowed: false, 
        remaining: 0, 
        resetAt: entry.windowStart + this.windowMs, 
        retryAfter: Math.ceil((entry.windowStart + this.windowMs - now) / 1000) 
      };
    }

    return { 
      allowed: true, 
      remaining: this.maxRequests - entry.count, 
      resetAt: entry.windowStart + this.windowMs 
    };
  }

  cleanup() {
    // LRUCache handles cleanup automatically based on ttl and max.
    // This is now a no-op for backward compatibility.
    this.cache.purgeStale();
  }

  get size() { return this.cache.size; }
}

module.exports = { BoundedRateLimiter };
