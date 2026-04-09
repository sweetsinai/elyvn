'use strict';

const { logAudit, sanitizeDetails, validateAction, fallbackLog, cleanupAuditLog } = require('../utils/auditLog');
const { logger } = require('../utils/logger');
const fs = require('fs');

jest.mock('fs');
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'mock-uuid-1234'),
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn(() => 'mock-hash-abc'),
  })),
}));

describe('Audit Log Utility', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-wire createHash mock after clearAllMocks (clearAllMocks resets mock implementations)
    const crypto = require('crypto');
    crypto.createHash.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn(() => 'mock-hash-abc'),
    });

    mockDb = {
      prepare: jest.fn((sql) => ({
        run: jest.fn(),
        get: jest.fn(),
        all: jest.fn(),
      })),
      // async query interface used by the source
      query: jest.fn().mockResolvedValue(null),
    };
    fs.appendFileSync.mockClear();

    // Spy on logger methods (auditLog uses getLogger() which returns the real logger)
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('sanitizeDetails', () => {
    test('sanitizes null/undefined to null', () => {
      expect(sanitizeDetails(null)).toBeNull();
      expect(sanitizeDetails(undefined)).toBeNull();
    });

    test('sanitizes string input', () => {
      expect(sanitizeDetails('hello world')).toBe('hello world');
    });

    test('converts object to JSON string', () => {
      const obj = { action: 'test', value: 123 };
      const result = sanitizeDetails(obj);
      expect(result).toBe(JSON.stringify(obj));
    });

    test('removes control characters', () => {
      const input = 'hello\x00world\x01test\x1Fvalue';
      const result = sanitizeDetails(input);
      expect(result).toBe('helloworldtestvalue');
    });

    test('preserves newlines in sanitization', () => {
      const input = 'line1\nline2\nline3';
      const result = sanitizeDetails(input);
      expect(result).toBe('line1\nline2\nline3');
    });

    test('limits size to 5000 characters', () => {
      const input = 'x'.repeat(10000);
      const result = sanitizeDetails(input);
      expect(result.length).toBe(5000);
    });

    test('handles non-serializable objects gracefully', () => {
      const obj = {};
      obj.self = obj; // Circular reference
      const result = sanitizeDetails(obj);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('sanitizes combined control characters and limits', () => {
      const input = 'start\x00\x01\x1F' + 'x'.repeat(10000) + '\x0E\x0Fend';
      const result = sanitizeDetails(input);
      expect(result.length).toBe(5000);
      expect(result).not.toContain('\x00');
      expect(result).not.toContain('\x1F');
    });
  });

  describe('validateAction', () => {
    test('allows known actions', () => {
      expect(validateAction('auth_success')).toEqual({ action: 'auth_success', isUnknown: false });
      expect(validateAction('lead_created')).toEqual({ action: 'lead_created', isUnknown: false });
      expect(validateAction('call_completed')).toEqual({ action: 'call_completed', isUnknown: false });
      expect(validateAction('webhook_received')).toEqual({ action: 'webhook_received', isUnknown: false });
    });

    test('marks unknown actions with isUnknown flag', () => {
      const result1 = validateAction('custom_action');
      expect(result1.action).toBe('custom_action');
      expect(result1.isUnknown).toBe(true);

      const result2 = validateAction('new_event');
      expect(result2.action).toBe('new_event');
      expect(result2.isUnknown).toBe(true);
    });

    test('handles null/undefined as invalid', () => {
      const result1 = validateAction(null);
      expect(result1.action).toBe('unknown:invalid_action');
      expect(result1.isUnknown).toBe(true);

      const result2 = validateAction(undefined);
      expect(result2.action).toBe('unknown:invalid_action');
      expect(result2.isUnknown).toBe(true);
    });

    test('handles non-string types as invalid', () => {
      expect(validateAction(123)).toEqual({ action: 'unknown:invalid_action', isUnknown: true });
      expect(validateAction({})).toEqual({ action: 'unknown:invalid_action', isUnknown: true });
      expect(validateAction([])).toEqual({ action: 'unknown:invalid_action', isUnknown: true });
    });

    test('handles empty string', () => {
      const result = validateAction('');
      expect(result.action).toBe('unknown:invalid_action');
      expect(result.isUnknown).toBe(true);
    });
  });

  describe('fallbackLog', () => {
    test('appends entry to fallback log file', () => {
      const entry = {
        id: 'test-id',
        action: 'test_action',
        created_at: new Date().toISOString(),
      };

      fallbackLog(entry);

      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(entry) + '\n'
      );
    });

    test('handles write errors gracefully', () => {
      fs.appendFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const entry = { id: 'test' };

      fallbackLog(entry);

      // auditLog uses getLogger().error — spy on logger.error
      expect(logger.error).toHaveBeenCalledWith(
        '[audit] Fallback log write failed:',
        'Write failed'
      );
    });
  });

  describe('logAudit', () => {
    test('writes entry to database', async () => {
      // db.query resolves with null for the hash lookup (empty table), then null for insert
      mockDb.query
        .mockResolvedValueOnce(null)  // getLatestHash SELECT
        .mockResolvedValueOnce(null); // INSERT

      await logAudit(mockDb, {
        clientId: 'client-123',
        userId: 'user-456',
        action: 'auth_success',
        resourceType: 'lead',
        resourceId: 'lead-789',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        details: { status: 'ok' },
      });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        expect.any(Array),
        'run'
      );
      // First param in the values array is the id
      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO audit_log'));
      expect(insertCall[1][0]).toBe('mock-uuid-1234');
    });

    test('sanitizes and validates action before logging', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)  // getLatestHash
        .mockResolvedValueOnce(null); // INSERT

      await logAudit(mockDb, {
        action: 'custom_unknown_action',
        details: 'test\x00data',
      });

      // logger.warn is spied on in beforeEach
      expect(logger.warn).toHaveBeenCalledWith(
        '[audit] Unknown action detected: custom_unknown_action'
      );

      // Verify the INSERT was called with the correct action and sanitized details
      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO audit_log'));
      expect(insertCall).toBeDefined();
      const params = insertCall[1];
      // params: [id, client_id, user_id, action, resource_type, resource_id, ip_address, user_agent, details, created_at, hash, previousHash]
      expect(params[3]).toBe('custom_unknown_action');
      expect(params[8]).toBe('testdata'); // Control chars removed
    });

    test('falls back to file logging on database error', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)  // getLatestHash
        .mockRejectedValueOnce(new Error('Database connection failed')); // INSERT

      fs.appendFileSync.mockClear();

      await logAudit(mockDb, {
        action: 'auth_failure',
        details: 'Failed login attempt',
      });

      expect(logger.error).toHaveBeenCalledWith('[audit] Log error:', 'Database connection failed');
      expect(fs.appendFileSync).toHaveBeenCalled();
    });

    test('handles null details gracefully', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await logAudit(mockDb, {
        action: 'lead_created',
        details: null,
      });

      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO audit_log'));
      expect(insertCall).toBeDefined();
      expect(insertCall[1][8]).toBeNull(); // details column (index 8)
    });

    test('returns early if no database provided', async () => {
      await logAudit(null, {
        action: 'auth_success',
      });

      // Should not throw, just return
      expect(true).toBe(true);
    });

    test('sets all optional fields to null when not provided', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await logAudit(mockDb, {
        action: 'auth_success',
        // No other fields provided
      });

      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO audit_log'));
      expect(insertCall).toBeDefined();
      const params = insertCall[1];
      // [id, client_id, user_id, action, resource_type, resource_id, ip_address, user_agent, details, created_at, hash, previousHash]
      expect(params[1]).toBeNull(); // client_id
      expect(params[2]).toBeNull(); // user_id
      expect(params[4]).toBeNull(); // resource_type
      expect(params[5]).toBeNull(); // resource_id
      expect(params[6]).toBeNull(); // ip_address
      expect(params[7]).toBeNull(); // user_agent
      expect(params[8]).toBeNull(); // details
    });

    test('creates timestamp for created_at', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const beforeTime = new Date();
      await logAudit(mockDb, { action: 'auth_success' });
      const afterTime = new Date();

      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO audit_log'));
      expect(insertCall).toBeDefined();
      const params = insertCall[1];
      // created_at is at index 9
      const createdAt = new Date(params[9]);

      expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe('cleanupAuditLog', () => {
    test('deletes old entries from database', async () => {
      mockDb.query.mockResolvedValueOnce({ changes: 42 });

      const result = await cleanupAuditLog(mockDb, 90);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM audit_log'),
        [90],
        'run'
      );
      expect(result).toBe(42);
    });

    test('uses default retention days of 90', async () => {
      mockDb.query.mockResolvedValueOnce({ changes: 10 });

      await cleanupAuditLog(mockDb);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.any(String),
        [90],
        'run'
      );
    });

    test('uses custom retention days', async () => {
      mockDb.query.mockResolvedValueOnce({ changes: 5 });

      await cleanupAuditLog(mockDb, 30);

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.any(String),
        [30],
        'run'
      );
    });

    test('returns 0 if no database provided', async () => {
      const result = await cleanupAuditLog(null, 90);
      expect(result).toBe(0);
    });

    test('returns 0 and logs error on cleanup failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Cleanup failed'));

      const result = await cleanupAuditLog(mockDb, 90);

      expect(result).toBe(0);
      expect(logger.error).toHaveBeenCalledWith('[audit] Cleanup failed:', 'Cleanup failed');
    });

    test('logs successful cleanup with change count', async () => {
      mockDb.query.mockResolvedValueOnce({ changes: 100 });

      await cleanupAuditLog(mockDb, 60);

      expect(logger.info).toHaveBeenCalledWith(
        '[audit] Cleaned up 100 entries older than 60 days'
      );
    });
  });

  describe('Integration scenarios', () => {
    test('full audit logging flow with valid action and details', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await logAudit(mockDb, {
        clientId: 'abc123',
        userId: 'user789',
        action: 'lead_updated',
        resourceType: 'lead',
        resourceId: 'lead456',
        ip: '10.0.0.1',
        userAgent: 'Chrome/120',
        details: { field: 'phone', oldValue: '555-1234', newValue: '555-5678' },
      });

      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO audit_log'));
      expect(insertCall).toBeDefined();
      expect(insertCall[1][3]).toBe('lead_updated'); // known action stored as-is
    });

    test('audit logging with unknown action gets flagged', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await logAudit(mockDb, {
        action: 'mysterious_event',
        details: { reason: 'testing' },
      });

      const insertCall = mockDb.query.mock.calls.find(c => c[0].includes('INSERT INTO audit_log'));
      expect(insertCall).toBeDefined();
      expect(insertCall[1][3]).toBe('mysterious_event'); // stored as-is
      expect(logger.warn).toHaveBeenCalledWith(
        '[audit] Unknown action detected: mysterious_event'
      );
    });

    test('large payload gets truncated and logged to file on error', async () => {
      mockDb.query
        .mockResolvedValueOnce(null)  // getLatestHash
        .mockRejectedValueOnce(new Error('Payload too large')); // INSERT fails

      const largeDetails = 'x'.repeat(10000);
      await logAudit(mockDb, {
        action: 'auth_success',
        details: largeDetails,
      });

      expect(fs.appendFileSync).toHaveBeenCalled();
      const callArgs = fs.appendFileSync.mock.calls[0];
      const loggedEntry = JSON.parse(callArgs[1].trim());
      expect(loggedEntry.details.length).toBe(5000);
    });
  });
});
