/**
 * Tests for dbAdapter.js
 * Tests database adapter initialization and health checks
 */

const path = require('path');

jest.mock('better-sqlite3');
jest.mock('../utils/migrations', () => ({
  runMigrations: jest.fn()
}));
jest.mock('../utils/supabaseAdapter', () => ({
  createSupabaseDatabase: jest.fn(() => {
    throw new Error('PostgreSQL adapter not yet implemented');
  }),
}));

describe('dbAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PATH;
  });

  describe('module exports', () => {
    test('exports createDatabase function', () => {
      const { createDatabase } = require('../utils/dbAdapter');
      expect(typeof createDatabase).toBe('function');
    });

    test('exports closeDatabase function', () => {
      const { closeDatabase } = require('../utils/dbAdapter');
      expect(typeof closeDatabase).toBe('function');
    });

    test('exports getDatabaseHealth function', () => {
      const { getDatabaseHealth } = require('../utils/dbAdapter');
      expect(typeof getDatabaseHealth).toBe('function');
    });
  });

  describe('createDatabase', () => {
    test('rejects PostgreSQL URLs', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@host/db';

      const { createDatabase } = require('../utils/dbAdapter');

      expect(() => createDatabase()).toThrow();
    });

    test('rejects postgres:// URLs', () => {
      process.env.DATABASE_URL = 'postgres://user:pass@host/db';

      const { createDatabase } = require('../utils/dbAdapter');

      expect(() => createDatabase()).toThrow(/PostgreSQL adapter not yet implemented/);
    });

    test('SQLite mode with environment variables', () => {
      delete process.env.DATABASE_URL;
      process.env.DATABASE_PATH = '/test/db.sqlite';

      // Mock better-sqlite3
      const mockDb = {
        pragma: jest.fn(() => []),
        close: jest.fn(),
        prepare: jest.fn(),
        exec: jest.fn(),
        transaction: jest.fn()
      };

      const Database = require('better-sqlite3');
      Database.mockImplementation(() => mockDb);

      const { createDatabase } = require('../utils/dbAdapter');
      const db = createDatabase();

      expect(db).toBeDefined();
    });

    test('accepts custom options', () => {
      delete process.env.DATABASE_URL;

      const mockDb = {
        pragma: jest.fn(() => []),
        close: jest.fn(),
        prepare: jest.fn(),
        exec: jest.fn(),
        transaction: jest.fn()
      };

      const Database = require('better-sqlite3');
      Database.mockImplementation(() => mockDb);

      const { createDatabase } = require('../utils/dbAdapter');
      const db = createDatabase({ path: '/custom/path.db' });

      expect(db).toBeDefined();
      expect(db._path).toBe('/custom/path.db');
    });
  });

  describe('closeDatabase', () => {
    test('handles null database gracefully', () => {
      const { closeDatabase } = require('../utils/dbAdapter');

      expect(() => closeDatabase(null)).not.toThrow();
    });

    test('handles undefined database gracefully', () => {
      const { closeDatabase } = require('../utils/dbAdapter');

      expect(() => closeDatabase(undefined)).not.toThrow();
    });

    test('closes database connection safely', () => {
      const mockDb = {
        pragma: jest.fn(() => []),
        close: jest.fn(),
        prepare: jest.fn(),
        exec: jest.fn(),
        transaction: jest.fn(),
        _adapter: 'sqlite'
      };

      const Database = require('better-sqlite3');
      Database.mockImplementation(() => mockDb);

      const { createDatabase, closeDatabase } = require('../utils/dbAdapter');
      const db = createDatabase({ path: ':memory:' });

      expect(() => closeDatabase(db)).not.toThrow();
      expect(mockDb.close).toHaveBeenCalled();
    });
  });

  describe('getDatabaseHealth', () => {
    test('handles null database gracefully', () => {
      const { getDatabaseHealth } = require('../utils/dbAdapter');

      const health = getDatabaseHealth(null);

      expect(health).toBeDefined();
      expect(health.status).toBe('disconnected');
    });

    test('returns health object structure', () => {
      const mockDb = {
        pragma: jest.fn((query) => {
          if (query === 'page_count') return [{ page_count: 100 }];
          if (query === 'page_size') return [{ page_size: 4096 }];
          if (query === 'freelist_count') return [{ freelist_count: 10 }];
          return [];
        }),
        close: jest.fn(),
        prepare: jest.fn(),
        exec: jest.fn(),
        transaction: jest.fn(),
        _adapter: 'sqlite',
        _path: '/test/db.db',
        _createdAt: new Date().toISOString()
      };

      const Database = require('better-sqlite3');
      Database.mockImplementation(() => mockDb);

      const { createDatabase, getDatabaseHealth } = require('../utils/dbAdapter');
      const db = createDatabase({ path: ':memory:' });

      const health = getDatabaseHealth(db);

      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('adapter');
      expect(health).toHaveProperty('path');
    });

    test('handles pragma errors gracefully', () => {
      const { runMigrations } = require('../utils/migrations');

      const mockDb = {
        pragma: jest.fn((query) => {
          // Fail only when called during getDatabaseHealth, not during createDatabase
          // Return empty array during createDatabase setup, throw during getDatabaseHealth
          if (query.includes('page_count') || query.includes('page_size') || query.includes('freelist_count')) {
            throw new Error('Pragma failed');
          }
          return [];
        }),
        close: jest.fn(),
        prepare: jest.fn(),
        exec: jest.fn(),
        transaction: jest.fn(),
        _adapter: 'sqlite',
        _path: '/test/db.db',
        _createdAt: new Date().toISOString()
      };

      const Database = require('better-sqlite3');
      Database.mockImplementation(() => mockDb);

      const { getDatabaseHealth } = require('../utils/dbAdapter');

      // Create db manually with proper mock
      const db = mockDb;

      const health = getDatabaseHealth(db);

      expect(health.status).toBe('error');
      expect(health.error).toBeDefined();
    });
  });

  describe('environment configuration', () => {
    test('uses DATABASE_PATH when set', () => {
      process.env.DATABASE_PATH = '/custom/path/db.sqlite';
      delete process.env.DATABASE_URL;

      const mockDb = {
        pragma: jest.fn(() => []),
        close: jest.fn(),
        prepare: jest.fn(),
        exec: jest.fn(),
        transaction: jest.fn()
      };

      const Database = require('better-sqlite3');
      Database.mockImplementation(() => mockDb);

      const { createDatabase } = require('../utils/dbAdapter');
      const db = createDatabase();

      expect(db._path).toBe('/custom/path/db.sqlite');
    });

    test('defaults to elyvn.db when DATABASE_PATH not set', () => {
      delete process.env.DATABASE_PATH;
      delete process.env.DATABASE_URL;

      const mockDb = {
        pragma: jest.fn(() => []),
        close: jest.fn(),
        prepare: jest.fn(),
        exec: jest.fn(),
        transaction: jest.fn()
      };

      const Database = require('better-sqlite3');
      Database.mockImplementation(() => mockDb);

      const { createDatabase } = require('../utils/dbAdapter');
      const db = createDatabase();

      expect(db._path).toContain('elyvn.db');
    });
  });
});
