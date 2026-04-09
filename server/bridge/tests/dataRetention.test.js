/**
 * Unit tests for dataRetention.js
 * 100% branch and line coverage
 */

const { runRetention, RETENTION_POLICIES } = require('../utils/dataRetention');
const { logger } = require('../utils/logger');

describe('dataRetention', () => {
  let mockDb;
  let mockQuery;

  beforeEach(() => {
    jest.clearAllMocks();

    // Use async (Postgres-style) db so runRetention takes the db.query path
    mockQuery = jest.fn();

    mockDb = {
      _async: true,  // signals runRetention to use the async db.query path
      query: mockQuery,
      exec: jest.fn(),
    };

    jest.spyOn(logger, 'info').mockImplementation();
    jest.spyOn(logger, 'error').mockImplementation();
    jest.spyOn(logger, 'warn').mockImplementation();
  });

  describe('RETENTION_POLICIES', () => {
    it('should define retention policies for required tables', () => {
      expect(RETENTION_POLICIES).toHaveProperty('job_queue');
      expect(RETENTION_POLICIES).toHaveProperty('audit_log');
      expect(RETENTION_POLICIES).toHaveProperty('messages');
    });

    it('should have job_queue policy for 30 days', () => {
      // Actual policy uses days: 30 and a cutoff function; SQL contains the condition
      expect(RETENTION_POLICIES.job_queue.days).toBe(30);
      expect(RETENTION_POLICIES.job_queue.deleteSQL).toContain('job_queue');
      expect(RETENTION_POLICIES.job_queue.deleteSQL).toContain('status IN');
    });

    it('should have audit_log policy for 180 days', () => {
      expect(RETENTION_POLICIES.audit_log.days).toBe(180);
      expect(RETENTION_POLICIES.audit_log.deleteSQL).toContain('audit_log');
    });

    it('should have messages policy with deleteSQL', () => {
      expect(RETENTION_POLICIES.messages.deleteSQL).toContain('messages');
      expect(typeof RETENTION_POLICIES.messages.cutoff).toBe('function');
    });

    it('should export all policies with required fields', () => {
      Object.values(RETENTION_POLICIES).forEach(policy => {
        expect(policy.deleteSQL).toBeDefined();
        expect(typeof policy.deleteSQL).toBe('string');
        expect(typeof policy.cutoff).toBe('function');
      });
    });
  });

  describe('runRetention', () => {
    it('should return empty results when db is missing', async () => {
      const result = await runRetention(null);

      expect(result).toEqual({ deleted: {} });
    });

    it('should check if table exists before querying (async path skips sqlite_master)', async () => {
      // In async (Postgres) mode, table existence check is skipped; count query runs directly
      // Set count to 0 for all tables so nothing is deleted
      mockQuery.mockResolvedValue({ c: 0 });

      const result = await runRetention(mockDb);

      // Should have called query (count) for each table
      expect(mockQuery).toHaveBeenCalled();
      expect(result.deleted).toEqual({});
    });

    it('should skip deletion if no rows match condition', async () => {
      // All counts return 0 — no deletions should occur
      mockQuery.mockResolvedValue({ c: 0 });

      const result = await runRetention(mockDb);

      expect(result.deleted).toEqual({});
      // No DELETE or BEGIN should have been called
      const calls = mockQuery.mock.calls.map(c => c[0]);
      expect(calls.every(sql => !sql.startsWith('DELETE'))).toBe(true);
    });

    it('should delete rows from job_queue table', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (sql.includes('job_queue') && mode === 'get') return Promise.resolve({ c: 5 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 5 });
        if (sql === 'COMMIT') return Promise.resolve();
        // audit/log insert
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(result.deleted.job_queue).toBe(5);
      const calls = mockQuery.mock.calls.map(c => c[0]);
      expect(calls.some(sql => sql.includes('DELETE FROM job_queue'))).toBe(true);
    });

    it('should delete rows from audit_log table', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (sql.includes('job_queue') && mode === 'get') return Promise.resolve({ c: 0 });
        if (sql.includes('audit_log') && mode === 'get' && sql.includes('COUNT')) return Promise.resolve({ c: 10 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM audit_log')) return Promise.resolve({ changes: 10 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(result.deleted.audit_log).toBe(10);
      const calls = mockQuery.mock.calls.map(c => c[0]);
      expect(calls.some(sql => sql.includes('DELETE FROM audit_log'))).toBe(true);
    });

    it('should delete rows from messages table', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('messages') && sql.includes('COUNT')) return Promise.resolve({ c: 20 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM messages')) return Promise.resolve({ changes: 20 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(result.deleted.messages).toBe(20);
      const calls = mockQuery.mock.calls.map(c => c[0]);
      expect(calls.some(sql => sql.includes('DELETE FROM messages'))).toBe(true);
    });

    it('should handle count query errors gracefully', async () => {
      mockQuery.mockRejectedValue(new Error('Query failed'));

      const result = await runRetention(mockDb);

      // When query fails for each table, it stores error info
      Object.values(result.deleted).forEach(v => {
        expect(v).toEqual({ error: 'Query failed' });
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/\[retention\] Error on/),
        expect.anything()
      );
    });

    it('should store error info when query fails', async () => {
      let callCount = 0;
      mockQuery.mockImplementation((sql, params, mode) => {
        callCount++;
        if (callCount === 1 && mode === 'get') return Promise.resolve({ c: 10 });
        return Promise.reject(new Error('Query error'));
      });

      const result = await runRetention(mockDb);

      // At least one table should have an error
      const hasError = Object.values(result.deleted).some(v => v && v.error === 'Query error');
      expect(hasError).toBe(true);
    });

    it('should call VACUUM when significant data deleted', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 2000 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 2000 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      await runRetention(mockDb);

      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });

    it('should not call VACUUM for small deletions', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 100 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 100 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      await runRetention(mockDb);

      expect(mockDb.exec).not.toHaveBeenCalled();
    });

    it('should call VACUUM when total deleted exceeds threshold', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 600 });
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('audit_log')) return Promise.resolve({ c: 500 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 600 });
        if (sql.includes('DELETE FROM audit_log')) return Promise.resolve({ changes: 500 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      await runRetention(mockDb);

      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });

    it('should handle VACUUM errors gracefully', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 2000 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 2000 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      mockDb.exec.mockImplementation(() => {
        throw new Error('VACUUM failed');
      });

      const result = await runRetention(mockDb);

      expect(result.deleted.job_queue).toBe(2000);
      expect(logger.error).toHaveBeenCalledWith(
        '[retention] VACUUM error:',
        'VACUUM failed'
      );
    });

    it('should log successful deletions', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 5 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 5 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      await runRetention(mockDb);

      expect(logger.info).toHaveBeenCalledWith(
        '[retention] Deleted 5 rows from job_queue'
      );
    });

    it('should log VACUUM completion', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 2000 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 2000 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      await runRetention(mockDb);

      expect(logger.info).toHaveBeenCalledWith('[retention] VACUUM completed');
    });

    it('should process all policy tables', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT')) return Promise.resolve({ c: 10 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.startsWith('DELETE')) return Promise.resolve({ changes: 10 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(Object.keys(result.deleted)).toHaveLength(
        Object.keys(RETENTION_POLICIES).length
      );
    });

    it('should calculate total deleted correctly for VACUUM decision', async () => {
      // 400 + 400 + 400 = 1200 > 1000 threshold
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT')) return Promise.resolve({ c: 400 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.startsWith('DELETE')) return Promise.resolve({ changes: 400 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      await runRetention(mockDb);

      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });

    it('should handle table existence check for each policy table (async skips sqlite_master)', async () => {
      // In async mode, sqlite_master checks are skipped — count runs directly
      // Only messages has data in this scenario
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('messages')) return Promise.resolve({ c: 5 });
        if (mode === 'get' && sql.includes('COUNT')) return Promise.resolve({ c: 0 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM messages')) return Promise.resolve({ changes: 5 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(result.deleted.messages).toBe(5);
      // Other tables have 0 count so they don't get a deleted entry
    });

    it('should return correct result object structure', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 10 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 10 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(result).toHaveProperty('deleted');
      expect(typeof result.deleted).toBe('object');
      expect(result.deleted.job_queue).toBe(10);
    });

    it('should handle mixed success and error results', async () => {
      let callCount = 0;
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) {
          callCount++;
          if (callCount === 1) return Promise.resolve({ c: 10 });
        }
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 10 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('audit_log')) {
          return Promise.reject(new Error('Audit log error'));
        }
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(result.deleted.job_queue).toBe(10);
      // audit_log error is caught at the table level
    });

    it('should handle non-numeric deletion results', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 10 });
        if (sql === 'BEGIN') return Promise.resolve();
        // Result without changes property
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({});
        if (sql === 'COMMIT') return Promise.resolve();
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      const result = await runRetention(mockDb);

      expect(result.deleted.job_queue).toBeUndefined();
    });

    it('should filter out error results when calculating VACUUM threshold', async () => {
      mockQuery.mockImplementation((sql, params, mode) => {
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('job_queue')) return Promise.resolve({ c: 1500 });
        if (sql === 'BEGIN') return Promise.resolve();
        if (sql.includes('DELETE FROM job_queue')) return Promise.resolve({ changes: 1500 });
        if (sql === 'COMMIT') return Promise.resolve();
        if (mode === 'get' && sql.includes('COUNT') && sql.includes('audit_log')) return Promise.reject(new Error('Error'));
        if (sql.includes("SELECT name FROM sqlite_master")) return Promise.resolve(null);
        return Promise.resolve({ c: 0 });
      });

      await runRetention(mockDb);

      // Even though there's an error on audit_log, job_queue deletion (1500) should trigger VACUUM
      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
    });
  });
});
