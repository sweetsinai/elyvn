'use strict';

const { BoundedRateLimiter } = require('../utils/rateLimiter');

describe('BoundedRateLimiter', () => {
  describe('constructor', () => {
    it('should use default options when none provided', () => {
      const limiter = new BoundedRateLimiter();
      expect(limiter.windowMs).toBe(60 * 1000);
      expect(limiter.maxRequests).toBe(120);
      expect(limiter.maxEntries).toBe(10000);
      expect(limiter.entries).toBeInstanceOf(Map);
      expect(limiter.size).toBe(0);
    });

    it('should use provided options', () => {
      const limiter = new BoundedRateLimiter({
        windowMs: 30 * 1000,
        maxRequests: 50,
        maxEntries: 5000
      });
      expect(limiter.windowMs).toBe(30 * 1000);
      expect(limiter.maxRequests).toBe(50);
      expect(limiter.maxEntries).toBe(5000);
    });

    it('should allow partial option overrides', () => {
      const limiter = new BoundedRateLimiter({ maxRequests: 100 });
      expect(limiter.windowMs).toBe(60 * 1000);
      expect(limiter.maxRequests).toBe(100);
      expect(limiter.maxEntries).toBe(10000);
    });
  });

  describe('check method - first request', () => {
    it('should allow first request and return correct metadata', () => {
      const limiter = new BoundedRateLimiter();
      const now = Date.now();
      const result = limiter.check('user:123');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(119); // 120 - 1
      expect(result.resetAt).toBeGreaterThanOrEqual(now + 60 * 1000);
      expect(result.resetAt).toBeLessThanOrEqual(now + 60 * 1000 + 10);
      expect(result.retryAfter).toBeUndefined();
    });

    it('should create new entry for new key', () => {
      const limiter = new BoundedRateLimiter();
      limiter.check('key1');
      expect(limiter.size).toBe(1);
    });

    it('should create separate entries for different keys', () => {
      const limiter = new BoundedRateLimiter();
      limiter.check('key1');
      limiter.check('key2');
      limiter.check('key3');
      expect(limiter.size).toBe(3);
    });
  });

  describe('check method - multiple requests within window', () => {
    it('should allow requests within limit', () => {
      const limiter = new BoundedRateLimiter({ maxRequests: 5 });
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(limiter.check('user:123'));
      }

      results.forEach((result, idx) => {
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(5 - (idx + 1));
        expect(result.retryAfter).toBeUndefined();
      });
    });

    it('should deny request when limit exceeded', () => {
      const limiter = new BoundedRateLimiter({ maxRequests: 3 });
      const now = Date.now();

      limiter.check('user:123');
      limiter.check('user:123');
      limiter.check('user:123');
      const result = limiter.check('user:123');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThanOrEqual(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
      expect(result.resetAt).toBeGreaterThanOrEqual(now);
    });

    it('should update lastAccess on each request', () => {
      const limiter = new BoundedRateLimiter();
      const key = 'user:123';

      // First request creates entry
      limiter.check(key);
      const entry1 = limiter.entries.get(key);
      const time1 = entry1.lastAccess;

      // Small delay
      const delayMs = 10;
      const waitUntil = Date.now() + delayMs;
      while (Date.now() < waitUntil) {} // Busy wait

      // Second request updates lastAccess
      limiter.check(key);
      const entry2 = limiter.entries.get(key);
      expect(entry2.lastAccess).toBeGreaterThan(time1);
    });

    it('should increment count for same key', () => {
      const limiter = new BoundedRateLimiter();
      const key = 'user:123';

      limiter.check(key);
      const entry1 = limiter.entries.get(key);
      expect(entry1.count).toBe(1);

      limiter.check(key);
      const entry2 = limiter.entries.get(key);
      expect(entry2.count).toBe(2);

      limiter.check(key);
      const entry3 = limiter.entries.get(key);
      expect(entry3.count).toBe(3);
    });
  });

  describe('check method - window expiration', () => {
    it('should reset counter after window expires', () => {
      const limiter = new BoundedRateLimiter({ windowMs: 100, maxRequests: 2 });
      const key = 'user:123';

      // First window
      limiter.check(key);
      limiter.check(key);
      let result = limiter.check(key);
      expect(result.allowed).toBe(false);

      // Wait for window to expire
      const waitUntil = Date.now() + 120;
      while (Date.now() < waitUntil) {}

      // Second window
      result = limiter.check(key);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it('should use same window for requests before expiration', () => {
      const limiter = new BoundedRateLimiter({ windowMs: 1000, maxRequests: 10 });
      const key = 'user:456';

      const result1 = limiter.check(key);
      const resetAt1 = result1.resetAt;

      // Immediately check again
      const result2 = limiter.check(key);
      const resetAt2 = result2.resetAt;

      // Same window, so same resetAt
      expect(resetAt1).toBe(resetAt2);
    });

    it('should handle window just at boundary', () => {
      const limiter = new BoundedRateLimiter({ windowMs: 100, maxRequests: 2 });
      const key = 'user:boundary';

      const entry1 = limiter.check(key);
      const windowStart = limiter.entries.get(key).windowStart;

      // Simulate a request exactly at window boundary
      const now = Date.now();
      const futureTime = windowStart + 100; // Exactly at boundary

      // Manually set time to future (we'll use mock)
      const saved = Date.now;
      Date.now = jest.fn(() => futureTime + 1);

      const result = limiter.check(key);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1); // New window

      Date.now = saved;
    });
  });

  describe('_evictIfNeeded method', () => {
    it('should not evict when under maxEntries', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 5 });

      limiter.check('key1');
      expect(limiter.size).toBe(1);

      limiter.check('key2');
      expect(limiter.size).toBe(2);

      limiter.check('key3');
      expect(limiter.size).toBe(3);

      // All entries should be preserved
      expect(limiter.entries.has('key1')).toBe(true);
      expect(limiter.entries.has('key2')).toBe(true);
      expect(limiter.entries.has('key3')).toBe(true);
    });

    it('should evict oldest entry when maxEntries exceeded', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 3 });

      // Add 3 entries
      limiter.check('key1');
      const wait1 = Date.now() + 10;
      while (Date.now() < wait1) {}

      limiter.check('key2');
      const wait2 = Date.now() + 10;
      while (Date.now() < wait2) {}

      limiter.check('key3');
      expect(limiter.size).toBe(3);

      // Add 4th entry - should trigger eviction
      limiter.check('key4');
      expect(limiter.size).toBe(3);

      // key1 should be evicted (oldest lastAccess)
      expect(limiter.entries.has('key1')).toBe(false);
      expect(limiter.entries.has('key2')).toBe(true);
      expect(limiter.entries.has('key3')).toBe(true);
      expect(limiter.entries.has('key4')).toBe(true);
    });

    it('should evict least recently used when maxEntries exceeded', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 2 });

      limiter.check('key1');
      const wait1 = Date.now() + 10;
      while (Date.now() < wait1) {}

      limiter.check('key2');

      // Access key1 again to update lastAccess
      const wait2 = Date.now() + 10;
      while (Date.now() < wait2) {}
      limiter.check('key1');

      // Now key2 is least recently used
      limiter.check('key3'); // Add 3rd entry, triggers eviction
      expect(limiter.size).toBe(2);
      expect(limiter.entries.has('key1')).toBe(true);
      expect(limiter.entries.has('key2')).toBe(false);
      expect(limiter.entries.has('key3')).toBe(true);
    });

    it('should preserve all entries when under maxEntries limit', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 100 });

      for (let i = 0; i < 50; i++) {
        limiter.check(`key${i}`);
      }

      expect(limiter.size).toBe(50);
      // All entries should exist
      for (let i = 0; i < 50; i++) {
        expect(limiter.entries.has(`key${i}`)).toBe(true);
      }
    });

    it('should handle single entry eviction', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 1 });

      limiter.check('only_key');
      expect(limiter.size).toBe(1);

      limiter.check('another_key');
      expect(limiter.size).toBe(1);
      expect(limiter.entries.has('only_key')).toBe(false);
      expect(limiter.entries.has('another_key')).toBe(true);
    });

    it('should call _evictIfNeeded correctly', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 2 });

      // Add 2 entries - at limit, no eviction needed
      limiter.check('key1');
      limiter.check('key2');
      expect(limiter.size).toBe(2);

      // Adding 3rd entry triggers eviction
      limiter.check('key3');
      expect(limiter.size).toBe(2);

      // Verify one of the old ones was removed
      const hasKey1Or2 = limiter.entries.has('key1') || limiter.entries.has('key2');
      const hasKey3 = limiter.entries.has('key3');
      expect(hasKey3).toBe(true);
    });

    it('should handle _evictIfNeeded with single entry', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 1 });

      // When we exceed maxEntries with a single entry in the map
      limiter.check('key1');
      expect(limiter.size).toBe(1);

      // Next check triggers eviction (size > maxEntries after set)
      limiter.check('key2');
      expect(limiter.size).toBe(1);
      expect(limiter.entries.has('key2')).toBe(true);
    });

    it('should test _evictIfNeeded directly for branch coverage', () => {
      const limiter = new BoundedRateLimiter({ maxEntries: 2 });

      // Manually populate entries and call _evictIfNeeded
      limiter.entries.set('key1', { count: 1, windowStart: Date.now(), lastAccess: Date.now() - 100 });
      limiter.entries.set('key2', { count: 1, windowStart: Date.now(), lastAccess: Date.now() });
      limiter.entries.set('key3', { count: 1, windowStart: Date.now(), lastAccess: Date.now() });

      expect(limiter.size).toBe(3);

      // Call _evictIfNeeded directly
      limiter._evictIfNeeded();

      expect(limiter.size).toBe(2);
      // key1 should be evicted (oldest lastAccess)
      expect(limiter.entries.has('key1')).toBe(false);
    });
  });

  describe('cleanup method', () => {
    it('should remove entries older than 2x windowMs', () => {
      const limiter = new BoundedRateLimiter({ windowMs: 100 });

      limiter.check('key1');
      limiter.check('key2');

      expect(limiter.size).toBe(2);

      // Simulate old entry by manipulating entry directly
      const entry1 = limiter.entries.get('key1');
      entry1.windowStart = Date.now() - 250; // Older than 2 * windowMs

      limiter.cleanup();

      expect(limiter.size).toBe(1);
      expect(limiter.entries.has('key1')).toBe(false);
      expect(limiter.entries.has('key2')).toBe(true);
    });

    it('should not remove entries younger than 2x windowMs', () => {
      const limiter = new BoundedRateLimiter({ windowMs: 1000 });

      limiter.check('key1');
      limiter.check('key2');
      limiter.check('key3');

      // Modify key1 to be relatively old but still within 2x window
      const entry1 = limiter.entries.get('key1');
      entry1.windowStart = Date.now() - 1500; // < 2000ms

      limiter.cleanup();

      expect(limiter.size).toBe(3);
      expect(limiter.entries.has('key1')).toBe(true);
    });

    it('should handle empty limiter', () => {
      const limiter = new BoundedRateLimiter();
      expect(() => limiter.cleanup()).not.toThrow();
      expect(limiter.size).toBe(0);
    });

    it('should remove multiple expired entries', () => {
      const limiter = new BoundedRateLimiter({ windowMs: 100 });

      for (let i = 0; i < 10; i++) {
        limiter.check(`key${i}`);
      }
      expect(limiter.size).toBe(10);

      // Make all entries old
      for (const [, entry] of limiter.entries) {
        entry.windowStart = Date.now() - 300;
      }

      limiter.cleanup();
      expect(limiter.size).toBe(0);
    });
  });

  describe('size property', () => {
    it('should return correct number of entries', () => {
      const limiter = new BoundedRateLimiter();
      expect(limiter.size).toBe(0);

      limiter.check('key1');
      expect(limiter.size).toBe(1);

      limiter.check('key2');
      expect(limiter.size).toBe(2);

      limiter.check('key3');
      expect(limiter.size).toBe(3);
    });

    it('should reflect size after cleanup', () => {
      const limiter = new BoundedRateLimiter({ windowMs: 100 });

      limiter.check('key1');
      limiter.check('key2');
      expect(limiter.size).toBe(2);

      for (const [, entry] of limiter.entries) {
        entry.windowStart = Date.now() - 300;
      }

      limiter.cleanup();
      expect(limiter.size).toBe(0);
    });
  });

  describe('integration scenarios', () => {
    it('should handle realistic rate limiting scenario', () => {
      const limiter = new BoundedRateLimiter({
        windowMs: 1000,
        maxRequests: 5,
        maxEntries: 10000
      });

      // User makes 5 requests
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(limiter.check('ip:192.168.1.1'));
      }

      // All should pass
      expect(results.filter(r => r.allowed)).toHaveLength(5);

      // 6th request should fail
      const result6 = limiter.check('ip:192.168.1.1');
      expect(result6.allowed).toBe(false);
      expect(result6.retryAfter).toBeGreaterThan(0);
    });

    it('should handle multiple simultaneous users', () => {
      const limiter = new BoundedRateLimiter({
        windowMs: 1000,
        maxRequests: 3
      });

      // User A: 3 requests
      limiter.check('user:A');
      limiter.check('user:A');
      limiter.check('user:A');

      // User B: 2 requests
      limiter.check('user:B');
      limiter.check('user:B');

      // User A's 4th request should fail
      const resultA = limiter.check('user:A');
      expect(resultA.allowed).toBe(false);

      // User B's 3rd request should pass
      const resultB = limiter.check('user:B');
      expect(resultB.allowed).toBe(true);
    });

    it('should handle continuous traffic with eviction', () => {
      const limiter = new BoundedRateLimiter({
        windowMs: 100,
        maxRequests: 10,
        maxEntries: 5
      });

      // Simulate traffic from 10 different sources
      for (let i = 0; i < 10; i++) {
        limiter.check(`ip:user${i}`);
      }

      // Only 5 should remain due to eviction
      expect(limiter.size).toBe(5);
    });
  });

  describe('edge cases', () => {
    it('should handle very large keys', () => {
      const limiter = new BoundedRateLimiter();
      const largeKey = 'x'.repeat(10000);
      const result = limiter.check(largeKey);
      expect(result.allowed).toBe(true);
      expect(limiter.size).toBe(1);
    });

    it('should handle numeric keys converted to string context', () => {
      const limiter = new BoundedRateLimiter();
      limiter.check('123');
      limiter.check('123');
      const result = limiter.check('123');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(120 - 3);
    });

    it('should maintain accuracy with rapid successive calls', () => {
      const limiter = new BoundedRateLimiter({ maxRequests: 100 });
      const results = [];

      for (let i = 0; i < 100; i++) {
        results.push(limiter.check('rapid'));
      }

      expect(results.every(r => r.allowed)).toBe(true);

      const result101 = limiter.check('rapid');
      expect(result101.allowed).toBe(false);
    });
  });
});
