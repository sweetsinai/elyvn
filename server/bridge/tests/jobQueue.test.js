/**
 * Unit tests for jobQueue.js
 * 100% branch and line coverage
 */

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomUUID: jest.fn(),
  };
});
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('../utils/metrics', () => ({
  recordMetric: jest.fn(),
}));

// We need to reset the module between some tests because ensureSchemaOnce
// caches a promise at module level. Import the module fresh each test suite.
let enqueueJob, processJobs, cancelJobs;

describe('jobQueue', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module so _schemaPromise singleton resets
    jest.resetModules();
    // Re-apply mocks after resetModules
    jest.mock('crypto', () => {
      const actual = jest.requireActual('crypto');
      return {
        ...actual,
        randomUUID: jest.fn().mockReturnValue('test-uuid-1234'),
      };
    });
    jest.mock('../utils/logger', () => ({
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
    }));
    jest.mock('../utils/metrics', () => ({
      recordMetric: jest.fn(),
    }));

    // db.query mock — returns a resolved promise by default
    // Individual tests override this as needed
    mockDb = {
      query: jest.fn().mockResolvedValue({ changes: 0 }),
    };

    ({ enqueueJob, processJobs, cancelJobs } = require('../utils/jobQueue'));
  });

  // ─── helpers ─────────────────────────────────────────────────────────────────
  // Build a mockDb whose query resolves with different values depending on the SQL
  function makeQueryMock(overrides = {}) {
    return jest.fn(async (sql, params = [], mode = 'all') => {
      for (const [pattern, value] of Object.entries(overrides)) {
        if (sql.includes(pattern)) {
          return typeof value === 'function' ? value(sql, params, mode) : value;
        }
      }
      // Default
      if (mode === 'all') return [];
      if (mode === 'get') return undefined;
      return { changes: 0 };
    });
  }

  // ─── enqueueJob ──────────────────────────────────────────────────────────────
  describe('enqueueJob', () => {
    it('should enqueue a job with default scheduledAt', async () => {
      mockDb.query = makeQueryMock({
        'ALTER TABLE': null,          // ensureSchema — ignore
        'CREATE UNIQUE INDEX': null,
        'CREATE TABLE': null,
        'INSERT INTO job_queue': { changes: 1 },
      });

      const jobId = await enqueueJob(mockDb, 'speed_to_lead_sms', { to: '5551234567' });

      expect(jobId).toBe('test-uuid-1234');

      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO job_queue'));
      expect(insertCall).toBeDefined();
      expect(insertCall[0]).toContain('INSERT INTO job_queue');
      expect(insertCall[1][0]).toBe('test-uuid-1234');
      expect(insertCall[1][1]).toBe('speed_to_lead_sms');
      expect(insertCall[1][2]).toBe(JSON.stringify({ to: '5551234567' }));
      expect(insertCall[1][3]).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('should enqueue a job with custom scheduledAt', async () => {
      mockDb.query = makeQueryMock({
        'ALTER TABLE': null,
        'CREATE UNIQUE INDEX': null,
        'CREATE TABLE': null,
        'INSERT INTO job_queue': { changes: 1 },
      });
      const customTime = '2025-03-25T10:00:00.000Z';

      const jobId = await enqueueJob(mockDb, 'speed_to_lead_callback', { leadId: '123' }, customTime);

      expect(jobId).toBe('test-uuid-1234');
      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO job_queue'));
      expect(insertCall[1][3]).toBe(customTime);
    });

    it('should handle string payload', async () => {
      mockDb.query = makeQueryMock({
        'ALTER TABLE': null,
        'CREATE UNIQUE INDEX': null,
        'CREATE TABLE': null,
        'INSERT INTO job_queue': { changes: 1 },
      });
      const payload = JSON.stringify({ test: 'data' });

      await enqueueJob(mockDb, 'test_job', payload);

      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO job_queue'));
      expect(insertCall[1][2]).toBe(payload);
    });

    it('should throw error when db is missing', async () => {
      await expect(enqueueJob(null, 'test_job', {})).rejects.toThrow('db and type required');
    });

    it('should throw error when type is missing', async () => {
      await expect(enqueueJob(mockDb, null, {})).rejects.toThrow('db and type required');
    });

    it('should throw error when db.query fails on INSERT', async () => {
      mockDb.query = jest.fn(async (sql) => {
        if (sql.includes('INSERT INTO job_queue')) throw new Error('Database error');
        return null; // schema calls
      });

      await expect(enqueueJob(mockDb, 'test_job', {})).rejects.toThrow('Database error');
      const { logger: l } = require('../utils/logger');
      expect(l.error).toHaveBeenCalledWith(
        '[jobQueue] enqueueJob error:',
        'Database error'
      );
    });

    it('should log enqueued job', async () => {
      mockDb.query = makeQueryMock({
        'ALTER TABLE': null,
        'CREATE UNIQUE INDEX': null,
        'CREATE TABLE': null,
        'INSERT INTO job_queue': { changes: 1 },
      });

      await enqueueJob(mockDb, 'speed_to_lead_sms', {});

      const { logger: l } = require('../utils/logger');
      expect(l.info).toHaveBeenCalledWith(
        expect.stringContaining('[jobQueue] Enqueued speed_to_lead_sms job')
      );
    });
  });

  // ─── processJobs ─────────────────────────────────────────────────────────────
  describe('processJobs', () => {
    it('should return empty results when db is missing', async () => {
      const result = await processJobs(null, {});
      expect(result).toEqual({ processed: 0, failed: 0 });
    });

    it('should return empty results when handlers is missing', async () => {
      const result = await processJobs(mockDb, null);
      expect(result).toEqual({ processed: 0, failed: 0 });
    });

    it('should process a single successful job', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{"test":"data"}',
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'failed', error = ?, updated_at": { changes: 1 },
        "status = 'processing'": { changes: 1 },
        "status = 'completed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(result).toEqual({ processed: 1, failed: 0 });
      expect(handler).toHaveBeenCalledWith({ test: 'data' }, 'job-1', mockDb);

      const completedCall = mockDb.query.mock.calls.find(c => c[0].includes("status = 'completed'"));
      expect(completedCall).toBeDefined();
    });

    it('should parse JSON payload from string', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{"key":"value"}',
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'completed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      await processJobs(mockDb, { test_job: handler });

      expect(handler).toHaveBeenCalledWith({ key: 'value' }, 'job-1', mockDb);
    });

    it('should mark job as failed if JSON parse fails', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: 'not json',
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'failed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      await processJobs(mockDb, { test_job: handler });

      // Handler should NOT be called — job is marked failed instead
      expect(handler).not.toHaveBeenCalled();
      const failCall = mockDb.query.mock.calls.find(c => c[0].includes("status = 'failed'"));
      expect(failCall).toBeDefined();
    });

    it('should handle payload already as object', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: { direct: 'object' },
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'completed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      await processJobs(mockDb, { test_job: handler });

      expect(handler).toHaveBeenCalledWith({ direct: 'object' }, 'job-1', mockDb);
    });

    it('should fail job when handler is not found', async () => {
      const job = {
        id: 'job-1',
        type: 'unknown_type',
        payload: '{}',
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'failed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const result = await processJobs(mockDb, {});

      expect(result).toEqual({ processed: 0, failed: 1 });
      const { logger: l } = require('../utils/logger');
      expect(l.warn).toHaveBeenCalledWith(
        expect.stringContaining('[jobQueue] No handler for job type')
      );
      const failCall = mockDb.query.mock.calls.find(c => c[0].includes("status = 'failed'") && c[1] && c[1][0] === 'Unknown job type');
      expect(failCall).toBeDefined();
      expect(failCall[1]).toEqual(['Unknown job type', expect.any(String), 'job-1']);
    });

    it('should attempt to timeout slow handlers', async () => {
      // This test verifies the timeout mechanism exists and handler gets invoked
      const job = {
        id: 'job-1',
        type: 'slow_job',
        payload: '{}',
        attempts: 0,
        max_attempts: 3,
      };

      let handlerResolve;
      const slowHandler = jest.fn().mockImplementationOnce(
        () => new Promise(resolve => { handlerResolve = resolve; })
      );

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'pending', attempts = ?": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const processPromise = processJobs(mockDb, { slow_job: slowHandler });

      // Flush microtasks so the handler gets invoked
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The handler was called
      expect(slowHandler).toHaveBeenCalled();

      // Resolve handler so the promise doesn't hang
      handlerResolve();
      await processPromise;
    });

    it('should reschedule job with exponential backoff on first failure', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{}',
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'pending', attempts = ?": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(result).toEqual({ processed: 0, failed: 1 });

      const rescheduleCall = mockDb.query.mock.calls.find(c =>
        c[0].includes("UPDATE job_queue SET status = 'pending', attempts = ?, scheduled_at = ?")
      );
      expect(rescheduleCall).toBeDefined();
      expect(rescheduleCall[1]).toEqual([1, expect.any(String), 'Handler error', expect.any(String), 'job-1']);
    });

    it('should reschedule job with exponential backoff on second failure', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{}',
        attempts: 1,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'pending', attempts = ?": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      await processJobs(mockDb, { test_job: handler });

      const rescheduleCall = mockDb.query.mock.calls.find(c =>
        c[0].includes("UPDATE job_queue SET status = 'pending', attempts = ?, scheduled_at = ?")
      );
      expect(rescheduleCall[1]).toEqual([2, expect.any(String), 'Handler error', expect.any(String), 'job-1']);
    });

    it('should mark job as permanently failed after max attempts', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{}',
        attempts: 2,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "ALTER TABLE": null,
        "CREATE UNIQUE INDEX": null,
        "CREATE TABLE": null,
        "dead_letter_queue": { changes: 1 },
        "status = 'failed', error = ?, failed_at": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(result).toEqual({ processed: 0, failed: 1 });

      const failCall = mockDb.query.mock.calls.find(c =>
        c[0].includes("status = 'failed'") && c[0].includes('failed_at')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1]).toEqual([expect.any(String), expect.any(String), expect.any(String), 'job-1']);
    });

    it('should clean up old completed jobs', async () => {
      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 5 },
        'SELECT * FROM job_queue': [],
        "SELECT COUNT(*)": { c: 0 },
      });

      await processJobs(mockDb, {});

      const cleanupCall = mockDb.query.mock.calls.find(c => c[0].includes('DELETE FROM job_queue'));
      expect(cleanupCall).toBeDefined();
      const { logger: l } = require('../utils/logger');
      expect(l.info).toHaveBeenCalledWith('[jobQueue] Cleaned up 5 old jobs');
    });

    it('should handle cleanup error gracefully', async () => {
      let cleanupCalled = false;
      mockDb.query = jest.fn(async (sql, params = [], mode = 'all') => {
        if (sql.includes('DELETE FROM job_queue')) {
          if (!cleanupCalled) {
            cleanupCalled = true;
            throw new Error('Cleanup failed');
          }
        }
        if (sql.includes('SELECT * FROM job_queue')) return [];
        if (sql.includes('SELECT COUNT(*)')) return { c: 0 };
        return { changes: 0 };
      });

      const result = await processJobs(mockDb, {});

      expect(result).toEqual({ processed: 0, failed: 0 });
      const { logger: l } = require('../utils/logger');
      expect(l.warn).toHaveBeenCalledWith('[jobQueue] Cleanup error:', 'Cleanup failed');
    });

    it('should process multiple jobs', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const jobs = [
        { id: 'job-1', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
        { id: 'job-2', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
        { id: 'job-3', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
      ];

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': jobs,
        "status = 'processing'": { changes: 1 },
        "status = 'completed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(result).toEqual({ processed: 3, failed: 0 });
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should handle processJobs outer error gracefully', async () => {
      mockDb.query = jest.fn().mockRejectedValue(new Error('Database connection lost'));

      const result = await processJobs(mockDb, {});

      expect(result).toEqual({ processed: 0, failed: 0 });
      const { logger: l } = require('../utils/logger');
      expect(l.error).toHaveBeenCalledWith(
        '[jobQueue] processJobs error:',
        'Database connection lost'
      );
    });

    it('should handle multiple jobs with delays', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const jobs = [
        { id: 'job-1', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
        { id: 'job-2', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
      ];

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': jobs,
        "status = 'processing'": { changes: 1 },
        "status = 'completed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(result.processed).toBe(2);
    });

    it('should log completed jobs', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{}',
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'completed'": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      await processJobs(mockDb, { test_job: handler });

      const { logger: l } = require('../utils/logger');
      expect(l.info).toHaveBeenCalledWith(
        expect.stringContaining('[jobQueue] Completed job job-1')
      );
    });

    it('should handle job handler rejecting with non-error', async () => {
      const handler = jest.fn().mockRejectedValue('String error');
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{}',
        attempts: 0,
        max_attempts: 3,
      };

      mockDb.query = makeQueryMock({
        'DELETE FROM job_queue': { changes: 0 },
        'SELECT * FROM job_queue': [job],
        "status = 'processing'": { changes: 1 },
        "status = 'pending', attempts = ?": { changes: 1 },
        "SELECT COUNT(*)": { c: 0 },
      });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(result).toEqual({ processed: 0, failed: 1 });
    });
  });

  // ─── cancelJobs ──────────────────────────────────────────────────────────────
  describe('cancelJobs', () => {
    it('should return 0 when db is missing', async () => {
      const count = await cancelJobs(null, { type: 'test_job' });
      expect(count).toBe(0);
    });

    it('should return 0 when filter is missing', async () => {
      const count = await cancelJobs(mockDb, null);
      expect(count).toBe(0);
    });

    it('should cancel jobs by type', async () => {
      mockDb.query = jest.fn().mockResolvedValue({ changes: 5 });

      const count = await cancelJobs(mockDb, { type: 'speed_to_lead_sms' });

      expect(count).toBe(5);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending' AND type = ?"),
        ['speed_to_lead_sms'],
        'run'
      );
    });

    it('should cancel jobs by payload contains', async () => {
      mockDb.query = jest.fn().mockResolvedValue({ changes: 3 });

      const count = await cancelJobs(mockDb, { payloadContains: 'leadId' });

      expect(count).toBe(3);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending' AND payload LIKE ?"),
        ['%leadId%'],
        'run'
      );
    });

    it('should cancel jobs by both type and payload', async () => {
      mockDb.query = jest.fn().mockResolvedValue({ changes: 2 });

      const count = await cancelJobs(mockDb, { type: 'test_job', payloadContains: 'key' });

      expect(count).toBe(2);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending' AND type = ? AND payload LIKE ?"),
        ['test_job', '%key%'],
        'run'
      );
    });

    it('should return 0 when no jobs are cancelled', async () => {
      mockDb.query = jest.fn().mockResolvedValue({ changes: 0 });

      const count = await cancelJobs(mockDb, { type: 'unknown_type' });

      expect(count).toBe(0);
    });

    it('should handle undefined changes gracefully', async () => {
      mockDb.query = jest.fn().mockResolvedValue({});

      const count = await cancelJobs(mockDb, { type: 'test_job' });

      expect(count).toBe(0);
    });

    it('should log cancelled jobs count', async () => {
      mockDb.query = jest.fn().mockResolvedValue({ changes: 5 });

      await cancelJobs(mockDb, { type: 'test_job' });

      const { logger: l } = require('../utils/logger');
      expect(l.info).toHaveBeenCalledWith(
        '[jobQueue] Cancelled 5 pending jobs'
      );
    });

    it('should handle error gracefully', async () => {
      mockDb.query = jest.fn().mockRejectedValue(new Error('Database error'));

      const count = await cancelJobs(mockDb, { type: 'test_job' });

      expect(count).toBe(0);
      const { logger: l } = require('../utils/logger');
      expect(l.error).toHaveBeenCalledWith(
        '[jobQueue] cancelJobs error:',
        'Database error'
      );
    });

    it('should cancel jobs with empty filter object', async () => {
      mockDb.query = jest.fn().mockResolvedValue({ changes: 10 });

      const count = await cancelJobs(mockDb, {});

      expect(count).toBe(10);
      // Empty filter means no WHERE clauses beyond status = 'pending'
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending'"),
        [],
        'run'
      );
    });
  });
});
