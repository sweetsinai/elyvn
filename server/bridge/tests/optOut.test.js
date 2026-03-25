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

    // Create a mock database
    db = {
      prepare: jest.fn()
    };
  });

  describe('isOptedOut', () => {
    test('should return true if number is opted out', () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue({ id: 'opt-out-123' })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = isOptedOut(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM sms_opt_outs')
      );
      expect(mockStatement.get).toHaveBeenCalledWith('+1234567890', 'client-123');
    });

    test('should return false if number is not opted out', () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null)
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = isOptedOut(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if db is null', () => {
      const result = isOptedOut(null, '+1234567890', 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is null', () => {
      const result = isOptedOut(db, null, 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is empty string', () => {
      const result = isOptedOut(db, '', 'client-123');

      expect(result).toBe(false);
    });

    test('should handle database errors gracefully', () => {
      const mockStatement = {
        get: jest.fn().mockImplementation(() => {
          throw new Error('Database error');
        })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = isOptedOut(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should check opt-outs for specific client only', () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue({ id: 'opt-out-123' })
      };

      db.prepare.mockReturnValue(mockStatement);

      isOptedOut(db, '+1234567890', 'client-456');

      expect(mockStatement.get).toHaveBeenCalledWith('+1234567890', 'client-456');
    });

    test('should check for opted_out_at being NOT NULL', () => {
      const mockStatement = {
        get: jest.fn().mockReturnValue(null)
      };

      db.prepare.mockReturnValue(mockStatement);

      isOptedOut(db, '+1234567890', 'client-123');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain('opted_out_at IS NOT NULL');
    });

    test('should return false for undefined db', () => {
      const result = isOptedOut(undefined, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined phone', () => {
      const result = isOptedOut(db, undefined, 'client-123');

      expect(result).toBe(false);
    });
  });

  describe('recordOptOut', () => {
    test('should record opt-out with user_request reason by default', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = recordOptOut(db, '+1234567890', 'client-123');

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

    test('should record opt-out with custom reason', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'STOP'
      );
    });

    test('should record opt-out with STOP keyword', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'STOP'
      );
    });

    test('should record opt-out with UNSUBSCRIBE keyword', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-123', 'UNSUBSCRIBE');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'UNSUBSCRIBE'
      );
    });

    test('should generate unique UUID for each opt-out', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);
      crypto.randomUUID.mockReturnValueOnce('uuid-1').mockReturnValueOnce('uuid-2');

      recordOptOut(db, '+1111111111', 'client-123');
      recordOptOut(db, '+2222222222', 'client-123');

      expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
      expect(mockStatement.run).toHaveBeenCalledWith('uuid-1', '+1111111111', 'client-123', 'user_request');
      expect(mockStatement.run).toHaveBeenCalledWith('uuid-2', '+2222222222', 'client-123', 'user_request');
    });

    test('should return false if db is null', () => {
      const result = recordOptOut(null, '+1234567890', 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is null', () => {
      const result = recordOptOut(db, null, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is null', () => {
      const result = recordOptOut(db, '+1234567890', null);

      expect(result).toBe(false);
    });

    test('should return false if phone is empty string', () => {
      const result = recordOptOut(db, '', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is empty string', () => {
      const result = recordOptOut(db, '+1234567890', '');

      expect(result).toBe(false);
    });

    test('should handle database errors gracefully', () => {
      const mockStatement = {
        run: jest.fn().mockImplementation(() => {
          throw new Error('Database error');
        })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = recordOptOut(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should use INSERT OR REPLACE to handle duplicates', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain('INSERT OR REPLACE');
    });

    test('should set opted_out_at to current time', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-123');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain("datetime('now')");
    });

    test('should return false for undefined db', () => {
      const result = recordOptOut(undefined, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined phone', () => {
      const result = recordOptOut(db, undefined, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined clientId', () => {
      const result = recordOptOut(db, '+1234567890', undefined);

      expect(result).toBe(false);
    });

    test('should record opt-out for multiple clients independently', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-1');
      recordOptOut(db, '+1234567890', 'client-2');

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
    test('should delete opt-out record for number', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sms_opt_outs')
      );
      expect(mockStatement.run).toHaveBeenCalledWith('+1234567890', 'client-123');
    });

    test('should return true even if no opt-out record exists', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 0 })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
    });

    test('should return false if db is null', () => {
      const result = recordOptIn(null, '+1234567890', 'client-123');

      expect(result).toBe(false);
      expect(db.prepare).not.toHaveBeenCalled();
    });

    test('should return false if phone is null', () => {
      const result = recordOptIn(db, null, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is null', () => {
      const result = recordOptIn(db, '+1234567890', null);

      expect(result).toBe(false);
    });

    test('should return false if phone is empty string', () => {
      const result = recordOptIn(db, '', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false if clientId is empty string', () => {
      const result = recordOptIn(db, '+1234567890', '');

      expect(result).toBe(false);
    });

    test('should handle database errors gracefully', () => {
      const mockStatement = {
        run: jest.fn().mockImplementation(() => {
          throw new Error('Database error');
        })
      };

      db.prepare.mockReturnValue(mockStatement);

      const result = recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should only delete for specific client', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptIn(db, '+1234567890', 'client-456');

      expect(mockStatement.run).toHaveBeenCalledWith('+1234567890', 'client-456');
    });

    test('should use DELETE query', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptIn(db, '+1234567890', 'client-123');

      const query = db.prepare.mock.calls[0][0];
      expect(query).toContain('DELETE FROM sms_opt_outs');
    });

    test('should return false for undefined db', () => {
      const result = recordOptIn(undefined, '+1234567890', 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined phone', () => {
      const result = recordOptIn(db, undefined, 'client-123');

      expect(result).toBe(false);
    });

    test('should return false for undefined clientId', () => {
      const result = recordOptIn(db, '+1234567890', undefined);

      expect(result).toBe(false);
    });

    test('should allow opt-in after opt-out', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      // First opt out
      recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      // Then opt in
      const result = recordOptIn(db, '+1234567890', 'client-123');

      expect(result).toBe(true);
    });
  });

  describe('Integration scenarios', () => {
    test('should handle opt-out detection workflow', () => {
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
      expect(isOptedOut(db, '+1234567890', 'client-123')).toBe(false);

      // Mock response for opted out
      mockGetStatement.get.mockReturnValue({ id: 'opt-out-123' });

      // Should be opted out
      expect(isOptedOut(db, '+1234567890', 'client-123')).toBe(true);

      // Opt in
      recordOptIn(db, '+1234567890', 'client-123');

      // Check that DELETE was called
      expect(mockDeleteStatement.run).toHaveBeenCalled();
    });

    test('should track STOP keyword opt-outs', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-123', 'STOP');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'STOP'
      );
    });

    test('should track UNSUBSCRIBE keyword opt-outs', () => {
      const mockStatement = {
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      recordOptOut(db, '+1234567890', 'client-123', 'UNSUBSCRIBE');

      expect(mockStatement.run).toHaveBeenCalledWith(
        mockUUID,
        '+1234567890',
        'client-123',
        'UNSUBSCRIBE'
      );
    });

    test('should maintain independent opt-out states per client', () => {
      const mockStatement = {
        get: jest.fn(),
        run: jest.fn().mockReturnValue({ changes: 1 })
      };

      db.prepare.mockReturnValue(mockStatement);

      // Phone opted out with client 1
      mockStatement.get.mockReturnValueOnce({ id: 'opt-out-1' });
      expect(isOptedOut(db, '+1234567890', 'client-1')).toBe(true);

      // Same phone NOT opted out with client 2
      mockStatement.get.mockReturnValueOnce(null);
      expect(isOptedOut(db, '+1234567890', 'client-2')).toBe(false);
    });
  });
});
