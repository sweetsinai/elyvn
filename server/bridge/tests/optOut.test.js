const { isOptedOut, recordOptOut, recordOptIn } = require('../utils/optOut');
const crypto = require('crypto');

// Mock dependencies
jest.mock('crypto');

describe('optOut.js', () => {
  let db;
  const mockUUID = 'mock-uuid-1234';

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock randomUUID
    crypto.randomUUID = jest.fn().mockReturnValue(mockUUID);

    // Create a mock database with query delegating to prepare
    db = {
      prepare: jest.fn(),
      query: jest.fn((sql, params = [], mode = 'all') => {
        try {
          const stmt = db.prepare(sql);
          if (mode === 'get') return Promise.resolve(stmt.get(...(params || [])));
          if (mode === 'run') return Promise.resolve(stmt.run(...(params || [])));
          return Promise.resolve(stmt.all ? stmt.all(...(params || [])) : []);
        } catch (err) {
          return Promise.reject(err);
        }
      }),
    };
  });

  describe('isOptedOut', () => {
    test('should return true if number is opted out', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue({ id: 'opt-out-123' })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await isOptedOut(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM sms_opt_outs')
      );
      expect(mockStatement.get).toHaveBeenCalledWith('+1234567890', 'client-123');
    });

    test('should return false if number is not opted out', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null)
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await isOptedOut(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if db is null', async () => {
      const result = await isOptedOut(null, '+1234567890', 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is null', async () => {
      const result = await isOptedOut(db, null, 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is empty string', async () => {
      const result = await isOptedOut(db, '', 'client-123');

      expect(result).toBe(false);
    });

    test('should handle database errors gracefully', async () => {
      const mockStatement = {
        get: jest.fn().mockImplementation(() => {
          throw new Error('Database error');
        })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await isOptedOut(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should check opt-outs for specific client only', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue({ id: 'opt-out-123' })
      };

      db.prepare.mockReturnValue(mockStatement);

      await isOptedOut(db, '+1234567890', 'client-456');

      expect(mockStatement.get).toHaveBeenCalledWith('+1234567890', 'client-456');
    });

    test('should check for opted_out_at being NOT NULL', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null)
      };

      db.prepare.mockReturnValue(mockStatement);

      await isOptedOut(db, '+1234567890', 'client-123');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain('opted_out_at IS NOT NULL');
    });

    test('should return false for undefined db', async () => {
      const result = await isOptedOut(undefined, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined phone', async () => {
      const result = await isOptedOut(db, undefined, 'client-123');

      expect(result).toBe(false);
    });
  });

  describe('recordOptOut', () => {
    test('should record opt-out with user_request reason by default', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await recordOptOut(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO sms_opt_outs')
      );
      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'user_request'
      );
    });

    test('should record opt-out with custom reason', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'STOP'
      );
    });

    test('should record opt-out with STOP keyword', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'STOP'
      );
    });

    test('should record opt-out with UNSUBSCRIBE keyword', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-123', 'UNSUBSCRIBE');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'UNSUBSCRIBE'
      );
    });

    test('should generate unique UUID for each opt-out', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);
      crypto.randomUUID.mockReturnValueOnce('uuid-1').mockReturnValueOnce('uuid-2');

      await recordOptOut(db, '+1111111111', 'client-123');
      await recordOptOut(db, '+2222222222', 'client-123');

      expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
      expect(mockStatement.run).toHaveBeenCalledWith('uuid-1', '+1111111111', 'client-123', 'user_request');
      expect(mockStatement.run).toHaveBeenCalledWith('uuid-2', '+2222222222', 'client-123', 'user_request');
    });

    test('should return false if db is null', async () => {
      const result = await recordOptOut(null, '+1234567890', 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is null', async () => {
      const result = await recordOptOut(db, null, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is null', async () => {
      const result = await recordOptOut(db, '+1234567890', null);

      expect(result).toBe(false);
    });

    test('should return false if phone is empty string', async () => {
      const result = await recordOptOut(db, '', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is empty string', async () => {
      const result = await recordOptOut(db, '+1234567890', '');

      expect(result).toBe(false);
    });

    test('should handle database errors gracefully', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockImplementation(() => {
          throw new Error('Database error');
        })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await recordOptOut(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should use INSERT OR REPLACE to handle duplicates', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain('INSERT OR REPLACE');
    });

    test('should set opted_out_at to current time', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-123');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain("datetime('now')");
    });

    test('should return false for undefined db', async () => {
      const result = await recordOptOut(undefined, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined phone', async () => {
      const result = await recordOptOut(db, undefined, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined clientId', async () => {
      const result = await recordOptOut(db, '+1234567890', undefined);

      expect(result).toBe(false);
    });

    test('should record opt-out for multiple clients independently', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-1');
      await recordOptOut(db, '+1234567890', 'client-2');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-1',
        'user_request'
      );
      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-2',
        'user_request'
      );
    });
  });

  describe('recordOptIn', () => {
    test('should delete opt-out record for number', async () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sms_opt_outs')
      );
      expect(mockStatement.run).toHaveBeenCalledWith('+1234567890', 'client-123');
    });

    test('should return true even if no opt-out record exists', async () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 0 })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
    });

    test('should return false if db is null', async () => {
      const result = await recordOptIn(null, '+1234567890', 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is null', async () => {
      const result = await recordOptIn(db, null, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is null', async () => {
      const result = await recordOptIn(db, '+1234567890', null);

      expect(result).toBe(false);
    });

    test('should return false if phone is empty string', async () => {
      const result = await recordOptIn(db, '', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is empty string', async () => {
      const result = await recordOptIn(db, '+1234567890', '');

      expect(result).toBe(false);
    });

    test('should handle database errors gracefully', async () => {
      const mockStatement = {
        run: jest.fn().mockImplementation(() => {
          throw new Error('Database error');
        })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = await recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should only delete for specific client', async () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptIn(db, '+1234567890', 'client-456');

      expect(mockStatement.run).toHaveBeenCalledWith('+1234567890', 'client-456');
    });

    test('should use DELETE query', async () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptIn(db, '+1234567890', 'client-123');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain('DELETE FROM sms_opt_outs');
    });

    test('should return false for undefined db', async () => {
      const result = await recordOptIn(undefined, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined phone', async () => {
      const result = await recordOptIn(db, undefined, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined clientId', async () => {
      const result = await recordOptIn(db, '+1234567890', undefined);

      expect(result).toBe(false);
    });

    test('should allow opt-in after opt-out', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      // First opt out
      await recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      // Then opt in
      const result = await recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
    });
  });

  describe('Integration scenarios', () => {
    test('should handle opt-out detection workflow', async () => {
      const mockGetStatement = {
        get: jest.fn().mockReturnValue(null)
      };
      const mockDeleteStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockImplementation((query) => {
        if (query.includes('SELECT')) return mockGetStatement;
        if (query.includes('DELETE')) return mockDeleteStatement;
      });

      // Initially not opted out
      expect(await isOptedOut(db, '+1234567890', 'client-123')).toBe(false);

      // Mock response for opted out
      mockGetStatement.get.mockReturnValue({ id: 'opt-out-123' });

      // Should be opted out
      expect(await isOptedOut(db, '+1234567890', 'client-123')).toBe(true);

      // Opt in
      await recordOptIn(db, '+1234567890', 'client-123');

      // Check that DELETE was called
      expect(mockDeleteStatement.run).toHaveBeenCalled();
    });

    test('should track STOP keyword opt-outs', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'STOP'
      );
    });

    test('should track UNSUBSCRIBE keyword opt-outs', async () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      await recordOptOut(db, '+1234567890', 'client-123', 'UNSUBSCRIBE');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'UNSUBSCRIBE'
      );
    });

    test('should maintain independent opt-out states per client', async () => {
      const mockStatement = {
        get: jest.fn(),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      // Phone opted out with client 1
      mockStatement.get.mockReturnValueOnce({ id: 'opt-out-1' });
      expect(await isOptedOut(db, '+1234567890', 'client-1')).toBe(true);

      // Same phone NOT opted out with client 2
      mockStatement.get.mockReturnValueOnce(null);
      expect(await isOptedOut(db, '+1234567890', 'client-2')).toBe(false);
    });
  });
});
