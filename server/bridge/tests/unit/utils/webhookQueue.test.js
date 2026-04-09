'use strict';

const path = require('path');

// Mock logger
jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock fs to avoid real file I/O
jest.mock('fs');

// Mock global fetch
global.fetch = jest.fn();

describe('webhookQueue', () => {
  let enqueue, processQueue, startProcessor, stopProcessor, _getQueuePath;
  let mockQueue;
  let fs; // declare here so we can re-require after resetModules

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    // Re-mock logger and fs after resetModules so the fresh module load gets the right mocks
    jest.mock('../../../utils/logger', () => ({
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    }));
    jest.mock('fs');

    // Re-require fs so we're working with the new mock instance
    fs = require('fs');

    mockQueue = [];

    // fs.existsSync — queue file and data dir exist by default
    fs.existsSync.mockReturnValue(true);

    // fs.readFileSync — returns current mockQueue
    fs.readFileSync.mockImplementation(() => JSON.stringify(mockQueue));

    // fs.writeFileSync — captures writes back to mockQueue
    fs.writeFileSync.mockImplementation((_p, data) => {
      mockQueue = JSON.parse(data);
    });

    // fs.mkdirSync — no-op
    fs.mkdirSync.mockImplementation(() => {});

    global.fetch = jest.fn();

    ({ enqueue, processQueue, startProcessor, stopProcessor, _getQueuePath } =
      require('../../../utils/webhookQueue'));
  });

  afterEach(() => {
    stopProcessor(); // ensure no lingering timers
    jest.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // enqueue
  // --------------------------------------------------------------------------

  describe('enqueue()', () => {
    it('should return a UUID string id on success', async () => {
      const id = await enqueue('https://example.com/hook', { event: 'test' });
      expect(typeof id).toBe('string');
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should write the entry to the queue', async () => {
      await enqueue('https://example.com/hook', { event: 'booking.created' });
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(mockQueue).toHaveLength(1);
      expect(mockQueue[0].url).toBe('https://example.com/hook');
      expect(mockQueue[0].payload).toEqual({ event: 'booking.created' });
    });

    it('should initialise attempts to 0', async () => {
      await enqueue('https://example.com/hook', {});
      expect(mockQueue[0].attempts).toBe(0);
    });

    it('should set retryAfter to now (due immediately)', async () => {
      const before = new Date();
      await enqueue('https://example.com/hook', {});
      const retryAfter = new Date(mockQueue[0].retryAfter);
      const after = new Date();
      expect(retryAfter.getTime()).toBeGreaterThanOrEqual(before.getTime() - 10);
      expect(retryAfter.getTime()).toBeLessThanOrEqual(after.getTime() + 10);
    });

    it('should store custom headers', async () => {
      await enqueue('https://example.com/hook', {}, { 'X-Client-Id': 'abc' });
      expect(mockQueue[0].headers).toEqual({ 'X-Client-Id': 'abc' });
    });

    it('should return null for an invalid (empty) url', async () => {
      const id = await enqueue('', { event: 'test' });
      expect(id).toBeNull();
      expect(mockQueue).toHaveLength(0);
    });

    it('should return null for a non-string url', async () => {
      const id = await enqueue(null, { event: 'test' });
      expect(id).toBeNull();
    });

    it('should return null for undefined url', async () => {
      const id = await enqueue(undefined, { event: 'test' });
      expect(id).toBeNull();
    });

    it('should append to an existing queue', async () => {
      await enqueue('https://a.com', { n: 1 });
      await enqueue('https://b.com', { n: 2 });
      expect(mockQueue).toHaveLength(2);
    });

    it('should return [] when queue file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);
      const id = await enqueue('https://example.com', {});
      expect(typeof id).toBe('string');
      expect(mockQueue).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // processQueue
  // --------------------------------------------------------------------------

  describe('processQueue()', () => {
    it('should return zeros when queue is empty', async () => {
      mockQueue = [];
      fs.readFileSync.mockReturnValue(JSON.stringify([]));
      const result = await processQueue();
      expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0, dropped: 0 });
    });

    it('should deliver a due entry and remove it on HTTP 2xx', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      await enqueue('https://example.com/hook', { event: 'test' });

      const result = await processQueue();
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.dropped).toBe(0);
      expect(mockQueue).toHaveLength(0);
    });

    it('should reschedule with backoff on delivery failure', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 500 });
      await enqueue('https://example.com/hook', { event: 'test' });

      const result = await processQueue();
      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(mockQueue).toHaveLength(1);
      expect(mockQueue[0].attempts).toBe(1);
    });

    it('should drop an entry after MAX_RETRIES (5) failures', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 503 });

      await enqueue('https://example.com/hook', { event: 'test' });

      // Run 5 failed attempts to exhaust retries
      // Each processQueue call reads the queue, so update mockQueue reads
      for (let i = 0; i < 5; i++) {
        // Make retryAfter in the past for the entry so it's due
        if (mockQueue.length > 0) {
          mockQueue[0].retryAfter = new Date(Date.now() - 1000).toISOString();
          fs.readFileSync.mockReturnValue(JSON.stringify(mockQueue));
        }
        await processQueue();
      }

      // After MAX_RETRIES the entry should be gone
      expect(mockQueue).toHaveLength(0);
    });

    it('should skip entries whose retryAfter is in the future', async () => {
      await enqueue('https://example.com/hook', { event: 'test' });
      // Set retryAfter to future
      mockQueue[0].retryAfter = new Date(Date.now() + 60000).toISOString();
      fs.readFileSync.mockReturnValue(JSON.stringify(mockQueue));

      const result = await processQueue();
      expect(result.attempted).toBe(0);
      expect(mockQueue).toHaveLength(1);
    });

    it('should sign payload with HMAC header when WEBHOOK_SIGNING_SECRET is set', async () => {
      process.env.WEBHOOK_SIGNING_SECRET = 'test-secret';
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      await enqueue('https://example.com/hook', { event: 'test' });

      await processQueue();

      const callArgs = global.fetch.mock.calls[0];
      const headersUsed = callArgs[1].headers;
      expect(headersUsed['X-Elyvn-Signature']).toMatch(/^sha256=/);

      delete process.env.WEBHOOK_SIGNING_SECRET;
    });

    it('should not include signature header when no secret is set', async () => {
      delete process.env.WEBHOOK_SIGNING_SECRET;
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      await enqueue('https://example.com/hook', { event: 'test' });

      await processQueue();

      const callArgs = global.fetch.mock.calls[0];
      const headersUsed = callArgs[1].headers;
      expect(headersUsed['X-Elyvn-Signature']).toBeUndefined();
    });

    it('should handle fetch network error (throws) as failure', async () => {
      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await enqueue('https://example.com/hook', { event: 'test' });

      const result = await processQueue();
      expect(result.failed).toBe(1);
      expect(mockQueue[0].lastError).toBe('ECONNREFUSED');
    });

    it('should set X-Elyvn-Delivery-Attempt header correctly', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      await enqueue('https://example.com/hook', { event: 'test' });

      await processQueue();

      const callArgs = global.fetch.mock.calls[0];
      expect(callArgs[1].headers['X-Elyvn-Delivery-Attempt']).toBe('1');
    });

    it('should set X-Elyvn-Webhook-Id header matching the entry id', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      const id = await enqueue('https://example.com/hook', { event: 'test' });

      await processQueue();

      const callArgs = global.fetch.mock.calls[0];
      expect(callArgs[1].headers['X-Elyvn-Webhook-Id']).toBe(id);
    });
  });

  // --------------------------------------------------------------------------
  // readQueue / queue file errors
  // --------------------------------------------------------------------------

  describe('queue file I/O', () => {
    it('should return [] when queue file has invalid JSON', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not-json{{{');
      // processQueue reading a broken file should not throw
      const result = await processQueue();
      expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0, dropped: 0 });
    });

    it('should return [] when queue file contains non-array JSON', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ not: 'array' }));
      const result = await processQueue();
      expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0, dropped: 0 });
    });
  });

  // --------------------------------------------------------------------------
  // startProcessor / stopProcessor
  // --------------------------------------------------------------------------

  describe('startProcessor() / stopProcessor()', () => {
    it('should not throw when startProcessor is called', () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      expect(() => startProcessor()).not.toThrow();
      stopProcessor();
    });

    it('should not start a second timer when called twice', () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200 });
      startProcessor();
      startProcessor(); // second call is a no-op
      stopProcessor();
    });

    it('should not throw when stopProcessor is called without starting', () => {
      expect(() => stopProcessor()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // _getQueuePath
  // --------------------------------------------------------------------------

  describe('_getQueuePath()', () => {
    it('should return a string path', () => {
      const qp = _getQueuePath();
      expect(typeof qp).toBe('string');
    });

    it('should end with webhook-queue.json', () => {
      const qp = _getQueuePath();
      expect(qp.endsWith('webhook-queue.json')).toBe(true);
    });
  });
});
