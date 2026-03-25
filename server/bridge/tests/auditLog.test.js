'use strict';

const { logAudit, sanitizeDetails, validateAction, fallbackLog, cleanupAuditLog } = require('../utils/auditLog');
const fs = require('fs');

jest.mock('fs');
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'mock-uuid-1234'),
}));

describe('Audit Log Utility', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = {
      prepare: jest.fn((sql) => ({
        run: jest.fn(),
        get: jest.fn(),
        all: jest.fn(),
      })),
    };
    fs.appendFileSync.mockClear();
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

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const entry = { id: 'test' };

      fallbackLog(entry);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[audit] Fallback log write failed:',
        'Write failed'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('logAudit', () => {
    test('writes entry to database', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      logAudit(mockDb, {
        clientId: 'client-123',
        userId: 'user-456',
        action: 'auth_success',
        resourceType: 'lead',
        resourceId: 'lead-789',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        details: { status: 'ok' },
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'));
      expect(mockRun).toHaveBeenCalled();
      const runCall = mockRun.mock.calls[0][0];
      expect(runCall).toBe('mock-uuid-1234'); // mocked UUID
    });

    test('sanitizes and validates action before logging', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      logAudit(mockDb, {
        action: 'custom_unknown_action',
        details: 'test\x00data',
      });

      expect(mockRun).toHaveBeenCalled();
      const args = mockRun.mock.calls[0];
      // Args: id, client_id, user_id, action, resource_type, resource_id, ip, user_agent, details, created_at
      expect(args[3]).toBe('custom_unknown_action'); // unknown action stored as-is
      expect(args[8]).toBe('testdata'); // Control chars removed
      expect(consoleSpy).toHaveBeenCalledWith(
        '[audit] Unknown action detected: custom_unknown_action'
      );

      consoleSpy.mockRestore();
    });

    test('falls back to file logging on database error', () => {
      const mockRun = jest.fn(() => {
        throw new Error('Database connection failed');
      });
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      fs.appendFileSync.mockClear();

      logAudit(mockDb, {
        action: 'auth_failure',
        details: 'Failed login attempt',
      });

      expect(consoleSpy).toHaveBeenCalledWith('[audit] Log error:', 'Database connection failed');
      expect(fs.appendFileSync).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    test('handles null details gracefully', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      logAudit(mockDb, {
        action: 'lead_created',
        details: null,
      });

      expect(mockRun).toHaveBeenCalled();
      const args = mockRun.mock.calls[0];
      expect(args[8]).toBeNull(); // details column
    });

    test('returns early if no database provided', () => {
      logAudit(null, {
        action: 'auth_success',
      });

      // Should not throw, just return
      expect(true).toBe(true);
    });

    test('sets all optional fields to null when not provided', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      logAudit(mockDb, {
        action: 'auth_success',
        // No other fields provided
      });

      expect(mockRun).toHaveBeenCalled();
      const args = mockRun.mock.calls[0];
      expect(args[1]).toBeNull(); // client_id
      expect(args[2]).toBeNull(); // user_id
      expect(args[4]).toBeNull(); // resource_type
      expect(args[5]).toBeNull(); // resource_id
      expect(args[6]).toBeNull(); // ip_address
      expect(args[7]).toBeNull(); // user_agent
      expect(args[8]).toBeNull(); // details
    });

    test('creates timestamp for created_at', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const beforeTime = new Date();
      logAudit(mockDb, { action: 'auth_success' });
      const afterTime = new Date();

      const args = mockRun.mock.calls[0];
      const createdAt = new Date(args[9]);

      expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe('cleanupAuditLog', () => {
    test('deletes old entries from database', () => {
      const mockRun = jest.fn().mockReturnValue({ changes: 42 });
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const result = cleanupAuditLog(mockDb, 90);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM audit_log')
      );
      expect(mockRun).toHaveBeenCalledWith(90);
      expect(result).toBe(42);
    });

    test('uses default retention days of 90', () => {
      const mockRun = jest.fn().mockReturnValue({ changes: 10 });
      mockDb.prepare.mockReturnValue({ run: mockRun });

      cleanupAuditLog(mockDb);

      expect(mockRun).toHaveBeenCalledWith(90);
    });

    test('uses custom retention days', () => {
      const mockRun = jest.fn().mockReturnValue({ changes: 5 });
      mockDb.prepare.mockReturnValue({ run: mockRun });

      cleanupAuditLog(mockDb, 30);

      expect(mockRun).toHaveBeenCalledWith(30);
    });

    test('returns 0 if no database provided', () => {
      const result = cleanupAuditLog(null, 90);
      expect(result).toBe(0);
    });

    test('returns 0 and logs error on cleanup failure', () => {
      const mockRun = jest.fn(() => {
        throw new Error('Cleanup failed');
      });
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const result = cleanupAuditLog(mockDb, 90);

      expect(result).toBe(0);
      expect(consoleSpy).toHaveBeenCalledWith('[audit] Cleanup failed:', 'Cleanup failed');

      consoleSpy.mockRestore();
    });

    test('logs successful cleanup with change count', () => {
      const mockRun = jest.fn().mockReturnValue({ changes: 100 });
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      cleanupAuditLog(mockDb, 60);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[audit] Cleaned up 100 entries older than 60 days'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Integration scenarios', () => {
    test('full audit logging flow with valid action and details', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      logAudit(mockDb, {
        clientId: 'abc123',
        userId: 'user789',
        action: 'lead_updated',
        resourceType: 'lead',
        resourceId: 'lead456',
        ip: '10.0.0.1',
        userAgent: 'Chrome/120',
        details: { field: 'phone', oldValue: '555-1234', newValue: '555-5678' },
      });

      expect(mockRun).toHaveBeenCalled();
      const args = mockRun.mock.calls[0];
      expect(args[3]).toBe('lead_updated'); // known action stored as-is
    });

    test('audit logging with unknown action gets flagged', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      logAudit(mockDb, {
        action: 'mysterious_event',
        details: { reason: 'testing' },
      });

      const args = mockRun.mock.calls[0];
      expect(args[3]).toBe('mysterious_event'); // stored as-is
      expect(consoleSpy).toHaveBeenCalledWith(
        '[audit] Unknown action detected: mysterious_event'
      );

      consoleSpy.mockRestore();
    });

    test('large payload gets truncated and logged to file on error', () => {
      const mockRun = jest.fn(() => {
        throw new Error('Payload too large');
      });
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const largeDetails = 'x'.repeat(10000);
      logAudit(mockDb, {
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
