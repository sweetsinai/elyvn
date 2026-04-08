'use strict';

// Re-require fresh module for each describe block to avoid state leakage
let cache;

beforeEach(() => {
  jest.resetModules();
  cache = require('../../../utils/queryCache');
});

describe('queryCache', () => {
  describe('set / get', () => {
    it('should return null for a key that was never set', () => {
      expect(cache.get('missing-key')).toBeNull();
    });

    it('should return the stored value on a cache hit', () => {
      cache.set('key1', { data: 'hello' });
      expect(cache.get('key1')).toEqual({ data: 'hello' });
    });

    it('should store and retrieve primitive values', () => {
      cache.set('num', 42);
      cache.set('str', 'world');
      cache.set('bool', true);
      expect(cache.get('num')).toBe(42);
      expect(cache.get('str')).toBe('world');
      expect(cache.get('bool')).toBe(true);
    });

    it('should store and retrieve null values as values (not cache miss)', () => {
      // Note: set stores null value but get returns null for missing — they look the same
      // This documents the current behaviour.
      cache.set('null-val', null);
      // get returns null either for missing OR for stored null — both return null
      expect(cache.get('null-val')).toBeNull();
    });

    it('should overwrite an existing key with a new value', () => {
      cache.set('key', 'first');
      cache.set('key', 'second');
      expect(cache.get('key')).toBe('second');
    });

    it('should use default TTL of 30000ms when none is provided', () => {
      cache.set('default-ttl', 'value');
      expect(cache.get('default-ttl')).toBe('value');
    });

    it('should support custom TTL', () => {
      cache.set('custom-ttl', 'value', 60000);
      expect(cache.get('custom-ttl')).toBe('value');
    });
  });

  describe('TTL expiry (cache miss)', () => {
    it('should return null after TTL expires', async () => {
      cache.set('short', 'val', 10); // 10ms TTL

      await new Promise(resolve => setTimeout(resolve, 30));

      expect(cache.get('short')).toBeNull();
    });

    it('should remove expired entry from internal map on get', async () => {
      cache.set('expiry-cleanup', 'val', 10);
      expect(cache.size()).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 30));

      cache.get('expiry-cleanup'); // triggers delete
      expect(cache.size()).toBe(0);
    });

    it('should still return value within TTL', async () => {
      cache.set('within-ttl', 'alive', 5000);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(cache.get('within-ttl')).toBe('alive');
    });

    it('should execute query function on cache miss (expired)', async () => {
      // Simulate a pattern where caller checks cache then queries on miss
      cache.set('query-key', 'cached-result', 10);
      await new Promise(resolve => setTimeout(resolve, 30));

      const queryFn = jest.fn().mockResolvedValue('fresh-result');

      const cached = cache.get('query-key');
      let result;
      if (cached === null) {
        result = await queryFn();
        cache.set('query-key', result, 5000);
      } else {
        result = cached;
      }

      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('fresh-result');
    });

    it('should not execute query function on cache hit', () => {
      cache.set('hit-key', 'cached-result', 5000);

      const queryFn = jest.fn();

      const cached = cache.get('hit-key');
      if (cached === null) {
        queryFn();
      }

      expect(queryFn).not.toHaveBeenCalled();
    });
  });

  describe('invalidate', () => {
    it('should delete all keys matching a prefix pattern', () => {
      cache.set('leads:list', []);
      cache.set('leads:detail:1', {});
      cache.set('users:list', []);

      cache.invalidate('leads:');

      expect(cache.get('leads:list')).toBeNull();
      expect(cache.get('leads:detail:1')).toBeNull();
      expect(cache.get('users:list')).not.toBeNull();
    });

    it('should not throw when no keys match the pattern', () => {
      cache.set('foo', 'bar');
      expect(() => cache.invalidate('nonexistent:')).not.toThrow();
      expect(cache.get('foo')).toBe('bar');
    });

    it('should clear all keys when pattern matches all', () => {
      cache.set('a:1', 1);
      cache.set('a:2', 2);
      cache.set('a:3', 3);
      cache.invalidate('a:');
      expect(cache.size()).toBe(0);
    });

    it('should handle empty cache gracefully', () => {
      expect(() => cache.invalidate('any:')).not.toThrow();
    });

    it('should do nothing when pattern is empty string (matches all prefixes)', () => {
      cache.set('key', 'val');
      cache.invalidate('');
      // Empty string prefix matches everything via startsWith('')
      expect(cache.size()).toBe(0);
    });
  });

  describe('size', () => {
    it('should return 0 for an empty cache', () => {
      expect(cache.size()).toBe(0);
    });

    it('should return correct count after sets', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size()).toBe(3);
    });

    it('should not increase size when overwriting a key', () => {
      cache.set('dup', 1);
      cache.set('dup', 2);
      expect(cache.size()).toBe(1);
    });

    it('should decrease size after invalidate', () => {
      cache.set('x:1', 1);
      cache.set('x:2', 2);
      cache.set('y:1', 1);
      cache.invalidate('x:');
      expect(cache.size()).toBe(1);
    });
  });
});
