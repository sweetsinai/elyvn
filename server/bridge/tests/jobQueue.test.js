const Database = require('better-sqlite3');
const { enqueueJob, processJobs, cancelJobs } = require('../utils/jobQueue');
const { runMigrations } = require('../utils/migrations');

describe('jobQueue', () => {
  let db;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    // Run migrations to set up schema
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('enqueueJob', () => {
    it('should create a job with correct fields', () => {
      const jobId = enqueueJob(db, 'speed_to_lead_sms', { phone: '+12125551234' });

      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      expect(job).toBeDefined();
      expect(job.type).toBe('speed_to_lead_sms');
      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(0);
      expect(job.max_attempts).toBe(3);
      expect(JSON.parse(job.payload)).toEqual({ phone: '+12125551234' });
    });

    it('should set scheduledAt to now if not provided', () => {
      const jobId = enqueueJob(db, 'test_job', {});
      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);

      const now = new Date();
      const scheduled = new Date(job.scheduled_at);
      // Should be within 5 seconds of now
      expect(Math.abs(now - scheduled)).toBeLessThan(5000);
    });

    it('should use provided scheduledAt timestamp', () => {
      const futureTime = new Date(Date.now() + 3600000).toISOString();
      const jobId = enqueueJob(db, 'test_job', {}, futureTime);
      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);

      expect(job.scheduled_at).toBe(futureTime);
    });

    it('should handle JSON payload', () => {
      const payload = { key1: 'value1', key2: 123 };
      const jobId = enqueueJob(db, 'test_job', payload);
      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);

      expect(JSON.parse(job.payload)).toEqual(payload);
    });

    it('should handle string payload', () => {
      const payload = 'string payload';
      const jobId = enqueueJob(db, 'test_job', payload);
      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);

      expect(job.payload).toBe(payload);
    });

    it('should throw error if db is missing', () => {
      expect(() => enqueueJob(null, 'test_job', {})).toThrow('db and type required');
    });

    it('should throw error if type is missing', () => {
      expect(() => enqueueJob(db, null, {})).toThrow('db and type required');
    });

    it('should return unique job IDs', () => {
      const id1 = enqueueJob(db, 'test_job', {});
      const id2 = enqueueJob(db, 'test_job', {});
      expect(id1).not.toBe(id2);
    });
  });

  describe('processJobs', () => {
    it('should process due jobs with correct status', async () => {
      const jobId = enqueueJob(db, 'test_job', { data: 'test' });
      const handler = jest.fn().mockResolvedValue(undefined);

      await processJobs(db, { test_job: handler });

      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      expect(job.status).toBe('completed');
      expect(handler).toHaveBeenCalled();
    });

    it('should skip future-scheduled jobs', async () => {
      const futureTime = new Date(Date.now() + 3600000).toISOString();
      const jobId = enqueueJob(db, 'test_job', {}, futureTime);
      const handler = jest.fn();

      await processJobs(db, { test_job: handler });

      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      expect(job.status).toBe('pending');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should retry failed jobs with exponential backoff', async () => {
      const jobId = enqueueJob(db, 'test_job', {});
      const handler = jest.fn().mockRejectedValue(new Error('test error'));

      await processJobs(db, { test_job: handler });

      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      expect(job.attempts).toBe(1);
      expect(job.status).toBe('pending'); // Rescheduled, not failed
      expect(job.error).toBe('test error');

      // Check that scheduled_at was moved forward
      const originalScheduled = new Date(new Date().toISOString());
      const newScheduled = new Date(job.scheduled_at);
      expect(newScheduled.getTime()).toBeGreaterThan(originalScheduled.getTime());
    });

    it('should mark as permanently failed after max_attempts', async () => {
      const jobId = enqueueJob(db, 'test_job', {});

      // Manually set attempts to max-1
      db.prepare('UPDATE job_queue SET attempts = 2, max_attempts = 3 WHERE id = ?').run(jobId);

      const handler = jest.fn().mockRejectedValue(new Error('final error'));

      await processJobs(db, { test_job: handler });

      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toBe('final error');
    });

    it('should handle unknown job types', async () => {
      const jobId = enqueueJob(db, 'unknown_job', {});
      await processJobs(db, { other_job: jest.fn() });

      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toBe('Unknown job type');
    });

    it('should parse JSON payload', async () => {
      const payload = { phone: '+12125551234', message: 'Hello' };
      const jobId = enqueueJob(db, 'test_job', payload);
      const handler = jest.fn().mockResolvedValue(undefined);

      await processJobs(db, { test_job: handler });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining(payload),
        jobId,
        db
      );
    });

    it('should cleanup old completed jobs', async () => {
      // Create a completed job
      const jobId = enqueueJob(db, 'test_job', {});
      db.prepare(
        "UPDATE job_queue SET status = 'completed', updated_at = datetime('now', '-8 days') WHERE id = ?"
      ).run(jobId);

      // Create a recent job that should not be deleted
      const recentJobId = enqueueJob(db, 'test_job', {});
      db.prepare("UPDATE job_queue SET status = 'completed' WHERE id = ?").run(recentJobId);

      await processJobs(db, {});

      const oldJob = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      const recentJob = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(recentJobId);

      expect(oldJob).toBeUndefined();
      expect(recentJob).toBeDefined();
    });

    it('should process multiple jobs', async () => {
      const jobId1 = enqueueJob(db, 'job_type_1', { id: 1 });
      const jobId2 = enqueueJob(db, 'job_type_2', { id: 2 });

      const handler1 = jest.fn().mockResolvedValue(undefined);
      const handler2 = jest.fn().mockResolvedValue(undefined);

      const result = await processJobs(db, {
        job_type_1: handler1,
        job_type_2: handler2,
      });

      expect(result.processed).toBe(2);
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should return processed and failed counts', async () => {
      enqueueJob(db, 'success_job', {});
      enqueueJob(db, 'fail_job', {});

      const result = await processJobs(db, {
        success_job: jest.fn().mockResolvedValue(undefined),
        fail_job: jest.fn().mockRejectedValue(new Error('error')),
      });

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
    });
  });

  describe('cancelJobs', () => {
    it('should cancel pending jobs by type', () => {
      const jobId1 = enqueueJob(db, 'cancel_me', {});
      const jobId2 = enqueueJob(db, 'keep_me', {});

      const cancelled = cancelJobs(db, { type: 'cancel_me' });

      expect(cancelled).toBe(1);

      const job1 = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId1);
      const job2 = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId2);

      expect(job1.status).toBe('cancelled');
      expect(job2.status).toBe('pending');
    });

    it('should cancel jobs matching payload content', () => {
      const jobId1 = enqueueJob(db, 'test_job', { leadId: 'lead123' });
      const jobId2 = enqueueJob(db, 'test_job', { leadId: 'lead456' });

      const cancelled = cancelJobs(db, { payloadContains: 'lead123' });

      expect(cancelled).toBe(1);

      const job1 = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId1);
      const job2 = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId2);

      expect(job1.status).toBe('cancelled');
      expect(job2.status).toBe('pending');
    });

    it('should not cancel non-pending jobs', () => {
      const jobId = enqueueJob(db, 'test_job', {});
      db.prepare("UPDATE job_queue SET status = 'completed' WHERE id = ?").run(jobId);

      const cancelled = cancelJobs(db, { type: 'test_job' });

      expect(cancelled).toBe(0);

      const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId);
      expect(job.status).toBe('completed');
    });

    it('should return 0 if no jobs match', () => {
      enqueueJob(db, 'some_job', {});
      const cancelled = cancelJobs(db, { type: 'nonexistent' });
      expect(cancelled).toBe(0);
    });

    it('should return 0 if filter is null', () => {
      enqueueJob(db, 'test_job', {});
      const cancelled = cancelJobs(db, null);
      expect(cancelled).toBe(0);
    });

    it('should return 0 if db is null', () => {
      const cancelled = cancelJobs(null, { type: 'test' });
      expect(cancelled).toBe(0);
    });

    it('should cancel multiple jobs matching type', () => {
      enqueueJob(db, 'cancel_all', {});
      enqueueJob(db, 'cancel_all', {});
      enqueueJob(db, 'cancel_all', {});

      const cancelled = cancelJobs(db, { type: 'cancel_all' });
      expect(cancelled).toBe(3);

      const count = db.prepare("SELECT COUNT(*) as c FROM job_queue WHERE status = 'cancelled'").get();
      expect(count.c).toBe(3);
    });
  });
});
