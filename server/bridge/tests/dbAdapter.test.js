/**
 * Tests for dbAdapter.js
 * Tests database adapter initialization and health checks
 */

const path = require('path');
const { createDatabase, closeDatabase, getDatabaseHealth } = require('../utils/dbAdapter');

jest.mock('../utils/migrations', () => ({
  runMigrations: jest.fn()
}));

jest.mock('better-sqlite3');

describe('dbAdapter', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Mock better-sqlite3 database instance
    mockDb = {
      pragma: jest.fn((query) => {
        if (query === 'journal_mode = WAL') return [];
        if (query === 'busy_timeout = 10000') return [];
        if (query === 'foreign_keys = ON') return [];
        if (query === 'synchronous = NORMAL') return [];
        if (query === 'cache_size = -64000') return [];
        if (query === 'temp_store = MEMORY') return [];
        if (query === 'wal_checkpoint(TRUNCATE)') return [];
        if (query === 'page_count') return [{ page_count: 100 }];
        if (query === 'page_size') return [{ page_size: 4096 }];
        if (query === 'freelist_count') return [{ freelist_count: 10 }];
        return [];
      }),
      close: jest.fn(),
      prepare: jest.fn(),
      exec: jest.fn()
    };

    const Database = require('better-sqlite3');
    Database.mockImplementation(() => mockDb);

    // Mock migrations
    const { runMigrations } = require('../utils/migrations');
    runMigrations.mockImplementation(() => {});
  });

  describe('createDatabase', () => {
    test('creates SQLite database connection', () => {
      const db = createDatabase();

      expect(db).toBeDefined();
      expect(db._adapter).toBe('sqlite');
    });

    test('uses DATABASE_PATH environment variable', () => {
      process.env.DATABASE_PATH = '/custom/path/db.sqlite';

      const db = createDatabase();

      expect(db._path).toBe('/custom/path/db.sqlite');
    });

    test('uses default database path when not configured', () => {
      delete process.env.DATABASE_PATH;

      const db = createDatabase();

      expect(db._path).toContain('elyvn.db');
    });

    test('accepts path option in constructor', () => {
      const db = createDatabase({ path: '/custom/db.sqlite' });

      expect(db._path).toBe('/custom/db.sqlite');
    });

    test('sets WAL mode for performance', () => {
      createDatabase();

      expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
    });

    test('sets busy timeout for concurrent access', () => {
      createDatabase();

      expect(mockDb.pragma).toHaveBeenCalledWith('busy_timeout = 10000');
    });

    test('enables foreign key constraints', () => {
      createDatabase();

      expect(mockDb.pragma).toHaveBeenCalledWith('foreign_keys = ON');
    });

    test('sets synchronous to NORMAL for speed with WAL', () => {
      createDatabase();

      expect(mockDb.pragma).toHaveBeenCalledWith('synchronous = NORMAL');
    });

    test('configures 64MB cache', () => {
      createDatabase();

      expect(mockDb.pragma).toHaveBeenCalledWith('cache_size = -64000');
    });

    test('uses memory for temporary tables', () => {
      createDatabase();

      expect(mockDb.pragma).toHaveBeenCalledWith('temp_store = MEMORY');
    });

    test('runs migrations after setup', () => {
      const { runMigrations } = require('../utils/migrations');

      createDatabase();

      expect(runMigrations).toHaveBeenCalledWith(mockDb);
    });

    test('attaches metadata to connection', () => {
      const db = createDatabase();

      expect(db._adapter).toBe('sqlite');
      expect(db._createdAt).toBeDefined();
      expect(db._path).toBeDefined();
    });

    test('throws error for PostgreSQL URLs', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@host/db';

      expect(() => createDatabase()).toThrow();
    });

    test('throws helpful error message for postgres:// URLs', () => {
      process.env.DATABASE_URL = 'postgres://user:pass@host/db';

      expect(() => createDatabase()).toThrow(/PostgreSQL adapter not yet implemented/);
    });

    test('supports verbose mode in development', () => {
      process.env.NODE_ENV = 'development';

      const db = createDatabase({ verbose: console.log });

      expect(db).toBeDefined();
    });

    test('accepts custom options', () => {
      const db = createDatabase({
        path: '/custom/path.db',
        verbose: true
      });

      expect(db._path).toBe('/custom/path.db');
    });
  });

  describe('closeDatabase', () => {
    test('closes database connection', () => {
      const db = createDatabase();

      closeDatabase(db);

      expect(mockDb.close).toHaveBeenCalled();
    });

    test('performs WAL checkpoint before closing', () => {
      const db = createDatabase();

      closeDatabase(db);

      expect(mockDb.pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
    });

    test('handles close errors gracefully', () => {
      mockDb.close.mockImplementation(() => {
        throw new Error('Close failed');
      });

      const db = createDatabase();

      expect(() => closeDatabase(db)).not.toThrow();
    });

    test('handles null database gracefully', () => {
      expect(() => closeDatabase(null)).not.toThrow();
    });

    test('skips checkpoint for non-SQLite adapters', () => {
      const db = createDatabase();
      db._adapter = 'postgres'; // Simulate different adapter

      mockDb.pragma.mockClear();

      closeDatabase(db);

      // Should not call pragma for non-SQLite adapters
      expect(mockDb.pragma).not.toHaveBeenCalledWith(expect.stringContaining('wal_checkpoint'));
    });
  });

  describe('getDatabaseHealth', () => {
    test('returns health status for connected database', () => {
      const db = createDatabase();

      const health = getDatabaseHealth(db);

      expect(health.status).toBe('connected');
      expect(health.adapter).toBe('sqlite');
    });

    test('returns database path in health check', () => {
      const db = createDatabase({ path: '/test/db.sqlite' });

      const health = getDatabaseHealth(db);

      expect(health.path).toBe('/test/db.sqlite');
    });

    test('returns connection timestamp', () => {
      const db = createDatabase();

      const health = getDatabaseHealth(db);

      expect(health.connected_since).toBeDefined();
      expect(new Date(health.connected_since)).toBeInstanceOf(Date);
    });

    test('calculates database size in MB', () => {
      const db = createDatabase();

      const health = getDatabaseHealth(db);

      expect(health.size_mb).toBeDefined();
      expect(typeof health.size_mb).toBe('number');
      expect(health.size_mb).toBeGreaterThanOrEqual(0);
    });

    test('includes freelist page count', () => {
      const db = createDatabase();

      const health = getDatabaseHealth(db);

      expect(health.freelist_pages).toBe(10);
    });

    test('confirms WAL mode enabled', () => {
      const db = createDatabase();

      const health = getDatabaseHealth(db);

      expect(health.wal_mode).toBe(true);
    });

    test('confirms foreign keys enforced', () => {
      const db = createDatabase();

      const health = getDatabaseHealth(db);

      expect(health.foreign_keys).toBe(true);
    });

    test('returns disconnected status when db is null', () => {
      const health = getDatabaseHealth(null);

      expect(health.status).toBe('disconnected');
    });

    test('handles pragma errors gracefully', () => {
      const db = createDatabase();
      mockDb.pragma.mockImplementation(() => {
        throw new Error('Pragma failed');
      });

      const health = getDatabaseHealth(db);

      expect(health.status).toBe('error');
      expect(health.error).toBeDefined();
    });

    test('calculates size correctly with large database', () => {
      mockDb.pragma.mockImplementation((query) => {
        if (query === 'page_count') return [{ page_count: 1000000 }];
        if (query === 'page_size') return [{ page_size: 4096 }];
        if (query === 'freelist_count') return [{ freelist_count: 0 }];
        return [];
      });

      const db = createDatabase();

      const health = getDatabaseHealth(db);

      // 1000000 * 4096 / 1024 / 1024 ≈ 3906.25 MB
      expect(health.size_mb).toBeGreaterThan(3900);
      expect(health.size_mb).toBeLessThan(4000);
    });

    test('includes all required fields in response', () => {
      const db = createDatabase();

      const health = getDatabaseHealth(db);

      const requiredFields = ['status', 'adapter', 'path', 'connected_since', 'size_mb', 'freelist_pages', 'wal_mode', 'foreign_keys'];
      for (const field of requiredFields) {
        expect(health).toHaveProperty(field);
      }
    });

    test('handles missing pragma results gracefully', () => {
      mockDb.pragma.mockReturnValue([]);

      const db = createDatabase();

      const health = getDatabaseHealth(db);

      expect(health.status).toBe('connected');
      expect(health.size_mb).toBe(0); // Falls back to 0
      expect(health.freelist_pages).toBe(0);
    });
  });

  describe('database persistence', () => {
    test('maintains connection metadata', () => {
      const db1 = createDatabase();
      const createdAt1 = db1._createdAt;

      expect(db1._createdAt).toBeDefined();
      expect(typeof db1._createdAt).toBe('string');
    });

    test('supports multiple database instances', () => {
      const db1 = createDatabase({ path: '/path1.db' });
      const db2 = createDatabase({ path: '/path2.db' });

      expect(db1._path).not.toBe(db2._path);
    });
  });
});
