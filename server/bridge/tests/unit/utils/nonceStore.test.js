'use strict';

// Mock logger before requiring the module
jest.mock('../../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// Ensure REDIS_URL is not set so tests use in-memory store
delete process.env.REDIS_URL;

describe('nonceStore (in-memory mode)', () => {
  let hasNonce, addNonce;

  beforeEach(() => {
    // Re-require each time to get a fresh module (clear the memStore Map)
    jest.resetModules();
    delete process.env.REDIS_URL;
    // Re-mock logger after resetModules
    jest.mock('../../../utils/logger', () => ({
      logger: {
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
      },
    }));
    ({ hasNonce, addNonce } = require('../../../utils/nonceStore'));
  });

  describe('addNonce / hasNonce', () => {
    it('should return false for a nonce that has not been added', async () => {
      const result = await hasNonce('nonce-not-added');
      expect(result).toBe(false);
    });

    it('should return false before a nonce is added', async () => {
      expect(await hasNonce('new-nonce')).toBe(false);
    });

    it('should return true after a nonce is added', async () => {
      await addNonce('my-nonce', 3600);
      expect(await hasNonce('my-nonce')).toBe(true);
    });

    it('should return true on second check — replay detected', async () => {
      await addNonce('replay-nonce', 3600);
      expect(await hasNonce('replay-nonce')).toBe(true);
      // Calling again still returns true (replay)
      expect(await hasNonce('replay-nonce')).toBe(true);
    });

    it('should treat different nonce strings as independent entries', async () => {
      await addNonce('nonce-A', 3600);
      expect(await hasNonce('nonce-A')).toBe(true);
      expect(await hasNonce('nonce-B')).toBe(false);
    });

    it('should use default TTL of 3600 seconds when not specified', async () => {
      await addNonce('default-ttl-nonce');
      expect(await hasNonce('default-ttl-nonce')).toBe(true);
    });
  });

  describe('TTL expiry', () => {
    it('should return false for a nonce after its TTL expires', async () => {
      await addNonce('short-lived', 0.001); // ~1ms TTL

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(await hasNonce('short-lived')).toBe(false);
    });

    it('should return true for a nonce within its TTL', async () => {
      await addNonce('long-lived', 3600);
      expect(await hasNonce('long-lived')).toBe(true);
    });

    it('should clean up expired nonce from memory on hasNonce check', async () => {
      await addNonce('expiring', 0.001); // ~1ms TTL
      await new Promise(resolve => setTimeout(resolve, 20));

      // First check: expired — returns false and deletes entry
      const result = await hasNonce('expiring');
      expect(result).toBe(false);

      // Re-add should work fine after cleanup
      await addNonce('expiring', 3600);
      expect(await hasNonce('expiring')).toBe(true);
    });
  });

  describe('LRU eviction at MAX_MEMORY_ENTRIES', () => {
    it('should evict oldest entries when store exceeds 10000', async () => {
      // Add enough entries to trigger eviction
      const MAX = 10000;
      for (let i = 0; i < MAX; i++) {
        await addNonce(`bulk-nonce-${i}`, 3600);
      }

      // The first entry should be evicted when we add one more
      await addNonce('overflow-nonce', 3600);
      expect(await hasNonce('bulk-nonce-0')).toBe(false);
      expect(await hasNonce('overflow-nonce')).toBe(true);
    });
  });
});
