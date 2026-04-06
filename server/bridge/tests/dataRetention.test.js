/**
 * Unit tests for dataRetention.js
 * 100% branch and line coverage
 */

const { runRetention, RETENTION_POLICIES } = require('../utils/dataRetention');
const { logger } = require('../utils/logger');

describe('dataRetention', () => {
  let mockDb;
  let mockStatement;
  let mockPrepare;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStatement = {
      get: jest.fn(),
      run: jest.fn(),
    };

    mockPrepare = jest.fn(() => mockStatement);

    mockDb = {
      prepare: mockPrepare,
      exec: jest.fn(),
    };

    jest.spyOn(logger, 'info').mockImplementation();
    jest.spyOn(logger, 'error').mockImplementation();
  });

  describe('RETENTION_POLICIES', () => {
    it('should define retention policies for required tables', () => {
      expect(RETENTION_POLICIES).toHaveProperty('job_queue');
      expect(RETENTION_POLICIES).toHaveProperty('audit_log');
      expect(RETENTION_POLICIES).toHaveProperty('messages');
    });

    it('should have job_queue policy for 30 days', () => {
      expect(RETENTION_POLICIES.job_queue.condition).toContain('30 days');
      expect(RETENTION_POLICIES.job_queue.condition).toContain('status IN');
    });

    it('should have audit_log policy for 90 days', () => {
      expect(RETENTION_POLICIES.audit_log.condition).toContain('90 days');
    });

    it('should have messages policy for 180 days with archive flag', () => {
      expect(RETENTION_POLICIES.messages.condition).toContain('180 days');
      expect(RETENTION_POLICIES.messages.archive).toBe(true);
    });

    it('should export all policies', () => {
      Object.values(RETENTION_POLICIES).forEach(policy => {
        expect(policy.condition).toBeDefined();
        expect(typeof policy.condition).toBe('string');
      });
    });
  });

  describe('runRetention', () => {
    it('should return empty results when db is missing', () => {
      const result = runRetention(null);

      expect(result).toEqual({ deleted: {} });
    });

    it('should check if table exists before querying', () => {
      mockStatement.get.mockReturnValue(null);

      runRetention(mockDb);

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("sqlite_master")
      );
    });

    it('should skip table if it does not exist', () => {
      mockStatement.get.mockReturnValue(null);

      const result = runRetention(mockDb);

      expect(result.deleted).toEqual({});
      expect(mockDb.exec).not.toHaveBeenCalled();
    });

    it('should delete rows from job_queue table', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' }) // exists
        .mockReturnValueOnce({ c: 5 }); // count

      mockStatement.run.mockReturnValue({ changes: 5 });

      const result = runRetention(mockDb);

      expect(result.deleted.job_queue).toBe(5);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM job_queue")
      );
    });

    it('should delete rows from audit_log table', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' }) // for job_queue check, doesn't exist
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ name: 'audit_log' }) // exists
        .mockReturnValueOnce({ c: 10 }); // count

      mockStatement.run.mockReturnValue({ changes: 10 });

      const result = runRetention(mockDb);

      expect(result.deleted.audit_log).toBe(10);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM audit_log")
      );
    });

    it('should delete rows from messages table', () => {
      mockStatement.get
        .mockReturnValueOnce(null) // job_queue doesn't exist
        .mockReturnValueOnce(null) // audit_log doesn't exist
        .mockReturnValueOnce({ name: 'messages' }) // exists
        .mockReturnValueOnce({ c: 20 }); // count

      mockStatement.run.mockReturnValue({ changes: 20 });

      const result = runRetention(mockDb);

      expect(result.deleted.messages).toBe(20);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM messages")
      );
    });

    it('should skip deletion if no rows match condition', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' }) // exists
        .mockReturnValueOnce({ c: 0 }); // count is 0

      mockStatement.run.mockReturnValue({ changes: 0 });

      runRetention(mockDb);

      expect(mockPrepare).not.toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM job_queue")
      );
    });

    it('should handle count query errors gracefully', () => {
      mockStatement.get.mockImplementation(() => {
        throw new Error('Query failed');
      });

      const result = runRetention(mockDb);

      // When query fails for each table, it stores error info
      expect(result.deleted.job_queue).toEqual({ error: 'Query failed' });
      expect(result.deleted.audit_log).toEqual({ error: 'Query failed' });
      expect(result.deleted.messages).toEqual({ error: 'Query failed' });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/\[retention\] Error on/),
        expect.anything()
      );
    });

    it('should store error info when query fails', () => {
      let callCount = 0;
      mockStatement.get.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { name: 'job_queue' }; // table exists
        throw new Error('Query error');
      });

      const result = runRetention(mockDb);

      expect(result.deleted.job_queue).toEqual({ error: 'Query error' });
    });

    it('should call VACUUM when significant data deleted', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 2000 });

      mockStatement.run.mockReturnValue({ changes: 2000 });

      runRetention(mockDb);

      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });

    it('should not call VACUUM for small deletions', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 100 });

      mockStatement.run.mockReturnValue({ changes: 100 });

      runRetention(mockDb);

      expect(mockDb.exec).not.toHaveBeenCalled();
    });

    it('should call VACUUM when total deleted exceeds threshold', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 600 })
        .mockReturnValueOnce({ name: 'audit_log' })
        .mockReturnValueOnce({ c: 500 });

      mockStatement.run.mockReturnValue({ changes: 0 });
      mockStatement.run
        .mockReturnValueOnce({ changes: 600 })
        .mockReturnValueOnce({ changes: 500 });

      runRetention(mockDb);

      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });

    it('should handle VACUUM errors gracefully', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 2000 });

      mockStatement.run.mockReturnValue({ changes: 2000 });
      mockDb.exec.mockImplementation(() => {
        throw new Error('VACUUM failed');
      });

      const result = runRetention(mockDb);

      expect(result.deleted.job_queue).toBe(2000);
      expect(logger.error).toHaveBeenCalledWith(
        '[retention] VACUUM error:',
        'VACUUM failed'
      );
    });

    it('should log successful deletions', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 5 });

      mockStatement.run.mockReturnValue({ changes: 5 });

      runRetention(mockDb);

      expect(logger.info).toHaveBeenCalledWith(
        '[retention] Deleted 5 rows from job_queue'
      );
    });

    it('should log VACUUM completion', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 2000 });

      mockStatement.run.mockReturnValue({ changes: 2000 });

      runRetention(mockDb);

      expect(logger.info).toHaveBeenCalledWith('[retention] VACUUM completed');
    });

    it('should process all policy tables', () => {
      const returnValues = [];
      Object.keys(RETENTION_POLICIES).forEach(() => {
        returnValues.push(
          { name: 'table' }, // exists
          { c: 10 } // count
        );
      });

      mockStatement.get.mockImplementation(() => {
        return returnValues.shift();
      });

      mockStatement.run.mockReturnValue({ changes: 10 });

      const result = runRetention(mockDb);

      expect(Object.keys(result.deleted)).toHaveLength(
        Object.keys(RETENTION_POLICIES).length
      );
    });

    it('should calculate total deleted correctly for VACUUM decision', () => {
      // Set up multiple table deletions
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 400 })
        .mockReturnValueOnce({ name: 'audit_log' })
        .mockReturnValueOnce({ c: 400 })
        .mockReturnValueOnce({ name: 'messages' })
        .mockReturnValueOnce({ c: 400 });

      mockStatement.run
        .mockReturnValueOnce({ changes: 400 })
        .mockReturnValueOnce({ changes: 400 })
        .mockReturnValueOnce({ changes: 400 });

      runRetention(mockDb);

      // Total is 1200, which exceeds 1000 threshold
      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });

    it('should handle table existence check for each policy table', () => {
      mockStatement.get
        .mockReturnValueOnce(null) // job_queue doesn't exist
        .mockReturnValueOnce(null) // audit_log doesn't exist
        .mockReturnValueOnce({ name: 'messages' }) // messages exists
        .mockReturnValueOnce({ c: 5 });

      mockStatement.run.mockReturnValue({ changes: 5 });

      const result = runRetention(mockDb);

      expect(result.deleted).toEqual({ messages: 5 });
    });

    it('should return correct result object structure', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 10 });

      mockStatement.run.mockReturnValue({ changes: 10 });

      const result = runRetention(mockDb);

      expect(result).toHaveProperty('deleted');
      expect(typeof result.deleted).toBe('object');
      expect(result.deleted.job_queue).toBe(10);
    });

    it('should handle mixed success and error results', () => {
      let callCount = 0;
      mockStatement.get.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { name: 'job_queue' };
        if (callCount === 2) return { c: 10 };
        if (callCount === 3) return { name: 'audit_log' };
        throw new Error('Audit log error');
      });

      mockStatement.run.mockReturnValue({ changes: 10 });

      const result = runRetention(mockDb);

      expect(result.deleted.job_queue).toBe(10);
      expect(result.deleted.audit_log).toEqual({ error: 'Audit log error' });
    });

    it('should handle non-numeric deletion results', () => {
      mockStatement.get
        .mockReturnValueOnce({ name: 'job_queue' })
        .mockReturnValueOnce({ c: 10 });

      // Result without changes property
      mockStatement.run.mockReturnValue({});

      const result = runRetention(mockDb);

      expect(result.deleted.job_queue).toBeUndefined();
    });

    it('should filter out error results when calculating VACUUM threshold', () => {
      let callCount = 0;
      mockStatement.get.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { name: 'job_queue' };
        if (callCount === 2) return { c: 1500 };
        if (callCount === 3) return { name: 'audit_log' };
        throw new Error('Error');
      });

      mockStatement.run.mockReturnValue({ changes: 1500 });

      runRetention(mockDb);

      // Even though there's an error on audit_log, job_queue deletion (1500) should trigger VACUUM
      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });
  });
});
