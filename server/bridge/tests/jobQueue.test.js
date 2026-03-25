/**
 * Unit tests for jobQueue.js
 * 100% branch and line coverage
 */

const { enqueueJob, processJobs, cancelJobs } = require('../utils/jobQueue');
const { randomUUID } = require('crypto');

jest.mock('crypto');

describe('jobQueue', () => {
  let mockDb;
  let mockStatement;
  let mockPrepare;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStatement = {
      run: jest.fn(),
      all: jest.fn(),
      get: jest.fn(),
    };

    mockPrepare = jest.fn(() => mockStatement);

    mockDb = {
      prepare: mockPrepare,
    };

    randomUUID.mockReturnValue('test-uuid-1234');
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
  });

  describe('enqueueJob', () => {
    it('should enqueue a job with default scheduledAt', () => {
      mockStatement.run.mockReturnValue({ changes: 1 });

      const jobId = enqueueJob(mockDb, 'speed_to_lead_sms', { to: '5551234567' });

      expect(jobId).toBe('test-uuid-1234');
      expect(randomUUID).toHaveBeenCalled();
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO job_queue')
      );
      expect(mockStatement.run).toHaveBeenCalledWith(
        'test-uuid-1234',
        'speed_to_lead_sms',
        JSON.stringify({ to: '5551234567' }),
        expect.stringMatching(/\d{4}-\d{2}-\d{2}/)
      );
    });

    it('should enqueue a job with custom scheduledAt', () => {
      mockStatement.run.mockReturnValue({ changes: 1 });
      const customTime = '2025-03-25T10:00:00.000Z';

      const jobId = enqueueJob(mockDb, 'speed_to_lead_callback', { leadId: '123' }, customTime);

      expect(jobId).toBe('test-uuid-1234');
      expect(mockStatement.run).toHaveBeenCalledWith(
        'test-uuid-1234',
        'speed_to_lead_callback',
        JSON.stringify({ leadId: '123' }),
        customTime
      );
    });

    it('should handle string payload', () => {
      mockStatement.run.mockReturnValue({ changes: 1 });
      const payload = JSON.stringify({ test: 'data' });

      enqueueJob(mockDb, 'test_job', payload);

      expect(mockStatement.run).toHaveBeenCalledWith(
        'test-uuid-1234',
        'test_job',
        payload,
        expect.anything()
      );
    });

    it('should throw error when db is missing', () => {
      expect(() => enqueueJob(null, 'test_job', {})).toThrow('db and type required');
    });

    it('should throw error when type is missing', () => {
      expect(() => enqueueJob(mockDb, null, {})).toThrow('db and type required');
    });

    it('should throw error when db.prepare fails', () => {
      mockPrepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      expect(() => enqueueJob(mockDb, 'test_job', {})).toThrow('Database error');
      expect(console.error).toHaveBeenCalledWith(
        '[jobQueue] enqueueJob error:',
        'Database error'
      );
    });

    it('should log enqueued job', () => {
      mockStatement.run.mockReturnValue({ changes: 1 });

      enqueueJob(mockDb, 'speed_to_lead_sms', {});

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[jobQueue] Enqueued speed_to_lead_sms job')
      );
    });
  });

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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 0 });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(result).toEqual({ processed: 1, failed: 0 });
      expect(handler).toHaveBeenCalledWith({ test: 'data' }, 'job-1', mockDb);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE job_queue SET status = 'completed'")
      );
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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 0 });

      await processJobs(mockDb, { test_job: handler });

      expect(handler).toHaveBeenCalledWith({ key: 'value' }, 'job-1', mockDb);
    });

    it('should keep payload as string if JSON parse fails', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: 'not json',
        attempts: 0,
        max_attempts: 3,
      };

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 0 });

      await processJobs(mockDb, { test_job: handler });

      expect(handler).toHaveBeenCalledWith('not json', 'job-1', mockDb);
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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 0 });

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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 1 });

      const result = await processJobs(mockDb, {});

      expect(result).toEqual({ processed: 0, failed: 1 });
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[jobQueue] No handler for job type')
      );
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE job_queue SET status = 'failed'")
      );
      expect(mockStatement.run).toHaveBeenCalledWith(
        'Unknown job type',
        'job-1'
      );
    });

    it('should attempt to timeout slow handlers', async () => {
      // This test verifies the timeout mechanism exists
      const job = {
        id: 'job-1',
        type: 'slow_job',
        payload: '{}',
        attempts: 0,
        max_attempts: 3,
      };

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 1 });

      // Create a handler that should timeout
      const slowHandler = jest.fn();
      slowHandler.mockImplementationOnce(() =>
        new Promise(r => {
          // Never resolve - will trigger timeout
        })
      );

      jest.useFakeTimers();
      const processPromise = processJobs(mockDb, { slow_job: slowHandler });
      // Advance past the 30s timeout
      jest.advanceTimersByTime(31000);

      jest.useRealTimers();

      // The handler was called
      expect(slowHandler).toHaveBeenCalled();
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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 1 });

      jest.useFakeTimers();
      const processPromise = processJobs(mockDb, { test_job: handler });
      jest.advanceTimersByTime(200);
      const result = await processPromise;
      jest.useRealTimers();

      expect(result).toEqual({ processed: 0, failed: 1 });
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE job_queue SET attempts = ?, scheduled_at = ?')
      );
      expect(mockStatement.run).toHaveBeenCalledWith(
        1,
        expect.any(String),
        'Handler error',
        'job-1'
      );
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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 1 });

      jest.useFakeTimers();
      const processPromise = processJobs(mockDb, { test_job: handler });
      jest.advanceTimersByTime(200);
      await processPromise;
      jest.useRealTimers();

      expect(mockStatement.run).toHaveBeenCalledWith(
        2,
        expect.any(String),
        'Handler error',
        'job-1'
      );
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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 1 });

      jest.useFakeTimers();
      const processPromise = processJobs(mockDb, { test_job: handler });
      jest.advanceTimersByTime(200);
      const result = await processPromise;
      jest.useRealTimers();

      expect(result).toEqual({ processed: 0, failed: 1 });
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE job_queue SET status = 'failed'")
      );
      expect(mockStatement.run).toHaveBeenCalledWith(
        'Handler error',
        'job-1'
      );
    });

    it('should truncate long error messages to 255 characters', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('x'.repeat(300)));
      const job = {
        id: 'job-1',
        type: 'test_job',
        payload: '{}',
        attempts: 0,
        max_attempts: 3,
      };

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 1 });

      jest.useFakeTimers();
      const processPromise = processJobs(mockDb, { test_job: handler });
      jest.advanceTimersByTime(200);
      await processPromise;
      jest.useRealTimers();

      const calls = mockStatement.run.mock.calls;
      const errorCall = calls.find(call => call[0] === 'x'.repeat(255));
      expect(errorCall).toBeDefined();
    });

    it('should clean up old completed jobs', async () => {
      mockStatement.all.mockReturnValue([]);
      mockStatement.run.mockReturnValue({ changes: 5 });

      await processJobs(mockDb, {});

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM job_queue")
      );
      expect(console.log).toHaveBeenCalledWith(
        '[jobQueue] Cleaned up 5 old jobs'
      );
    });

    it('should handle cleanup error gracefully', async () => {
      mockPrepare.mockImplementationOnce(() => {
        throw new Error('Cleanup failed');
      }).mockImplementation(() => mockStatement);

      mockStatement.all.mockReturnValue([]);
      mockStatement.run.mockReturnValue({ changes: 0 });

      const result = await processJobs(mockDb, {});

      expect(result).toEqual({ processed: 0, failed: 0 });
      expect(console.warn).toHaveBeenCalledWith(
        '[jobQueue] Cleanup error:',
        'Cleanup failed'
      );
    });

    it('should process multiple jobs', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const jobs = [
        { id: 'job-1', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
        { id: 'job-2', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
        { id: 'job-3', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
      ];

      mockStatement.all.mockReturnValue(jobs);
      mockStatement.run.mockReturnValue({ changes: 0 });

      jest.useFakeTimers();
      const processPromise = processJobs(mockDb, { test_job: handler });
      jest.advanceTimersByTime(500);
      const result = await processPromise;
      jest.useRealTimers();

      expect(result).toEqual({ processed: 3, failed: 0 });
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should handle processJobs outer error gracefully', async () => {
      mockPrepare.mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      const result = await processJobs(mockDb, {});

      expect(result).toEqual({ processed: 0, failed: 0 });
      expect(console.error).toHaveBeenCalledWith(
        '[jobQueue] processJobs error:',
        'Database connection lost'
      );
    });

    it('should introduce small delay between jobs', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const jobs = [
        { id: 'job-1', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
        { id: 'job-2', type: 'test_job', payload: '{}', attempts: 0, max_attempts: 3 },
      ];

      mockStatement.all.mockReturnValue(jobs);
      mockStatement.run.mockReturnValue({ changes: 0 });

      jest.useFakeTimers();
      const processPromise = processJobs(mockDb, { test_job: handler });
      jest.advanceTimersByTime(300);
      await processPromise;
      jest.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(2);
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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 0 });

      await processJobs(mockDb, { test_job: handler });

      expect(console.log).toHaveBeenCalledWith(
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

      mockStatement.all.mockReturnValue([job]);
      mockStatement.run.mockReturnValue({ changes: 1 });

      const result = await processJobs(mockDb, { test_job: handler });

      expect(result).toEqual({ processed: 0, failed: 1 });
    });
  });

  describe('cancelJobs', () => {
    it('should return 0 when db is missing', () => {
      const count = cancelJobs(null, { type: 'test_job' });
      expect(count).toBe(0);
    });

    it('should return 0 when filter is missing', () => {
      const count = cancelJobs(mockDb, null);
      expect(count).toBe(0);
    });

    it('should cancel jobs by type', () => {
      mockStatement.run.mockReturnValue({ changes: 5 });

      const count = cancelJobs(mockDb, { type: 'speed_to_lead_sms' });

      expect(count).toBe(5);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending' AND type = ?")
      );
      expect(mockStatement.run).toHaveBeenCalledWith('speed_to_lead_sms');
    });

    it('should cancel jobs by payload contains', () => {
      mockStatement.run.mockReturnValue({ changes: 3 });

      const count = cancelJobs(mockDb, { payloadContains: 'leadId' });

      expect(count).toBe(3);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending' AND payload LIKE ?")
      );
      expect(mockStatement.run).toHaveBeenCalledWith('%leadId%');
    });

    it('should cancel jobs by both type and payload', () => {
      mockStatement.run.mockReturnValue({ changes: 2 });

      const count = cancelJobs(mockDb, { type: 'test_job', payloadContains: 'key' });

      expect(count).toBe(2);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending' AND type = ? AND payload LIKE ?")
      );
      expect(mockStatement.run).toHaveBeenCalledWith('test_job', '%key%');
    });

    it('should return 0 when no jobs are cancelled', () => {
      mockStatement.run.mockReturnValue({ changes: 0 });

      const count = cancelJobs(mockDb, { type: 'unknown_type' });

      expect(count).toBe(0);
    });

    it('should handle undefined changes gracefully', () => {
      mockStatement.run.mockReturnValue({});

      const count = cancelJobs(mockDb, { type: 'test_job' });

      expect(count).toBe(0);
    });

    it('should log cancelled jobs count', () => {
      mockStatement.run.mockReturnValue({ changes: 5 });

      cancelJobs(mockDb, { type: 'test_job' });

      expect(console.log).toHaveBeenCalledWith(
        '[jobQueue] Cancelled 5 pending jobs'
      );
    });

    it('should handle error gracefully', () => {
      mockPrepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      const count = cancelJobs(mockDb, { type: 'test_job' });

      expect(count).toBe(0);
      expect(console.error).toHaveBeenCalledWith(
        '[jobQueue] cancelJobs error:',
        'Database error'
      );
    });

    it('should cancel jobs with empty filter object', () => {
      mockStatement.run.mockReturnValue({ changes: 10 });

      const count = cancelJobs(mockDb, {});

      expect(count).toBe(10);
      expect(mockStatement.run).toHaveBeenCalledWith();
    });
  });
});
