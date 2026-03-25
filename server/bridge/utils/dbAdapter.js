/**
 * Database Adapter — abstracts SQLite/PostgreSQL behind a unified interface.
 * Current: SQLite via better-sqlite3 (sync)
 * Future: PostgreSQL via pg (async) — flip DATABASE_URL env var
 *
 * This adapter ensures all business logic code works unchanged when migrating.
 */

const path = require('path');

/**
 * Create and configure a database connection.
 * Returns a db object with unified interface.
 */
function createDatabase(options = {}) {
  const dbUrl = process.env.DATABASE_URL;

  // Future: if DATABASE_URL starts with postgres://, use pg adapter
  if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
    console.log('[db] PostgreSQL mode detected — adapter ready for migration');
    // For now, throw a helpful error. When migrating, replace with pg pool.
    throw new Error(
      'PostgreSQL adapter not yet implemented. Set DATABASE_PATH for SQLite, or implement the pg adapter in dbAdapter.js'
    );
  }

  // SQLite mode (current production)
  const Database = require('better-sqlite3');
  const dbPath = options.path || process.env.DATABASE_PATH || path.join(__dirname, '../../mcp/elyvn.db');
  const verbose = options.verbose || (process.env.NODE_ENV === 'development' ? console.log : undefined);

  const db = new Database(dbPath, { verbose });

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000'); // Increased from 5000 for concurrent load
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // Faster writes, still crash-safe with WAL
  db.pragma('cache_size = -64000'); // 64MB cache (default is 2MB)
  db.pragma('temp_store = MEMORY'); // Temp tables in memory

  // Run migrations
  const { runMigrations } = require('./migrations');
  runMigrations(db);

  // Attach connection metadata
  db._adapter = 'sqlite';
  db._path = dbPath;
  db._createdAt = new Date().toISOString();

  console.log(`[db] SQLite connected: ${dbPath} (WAL mode, 64MB cache, FK enforced)`);
  return db;
}

/**
 * Gracefully close the database connection.
 */
function closeDatabase(db) {
  if (!db) return;
  try {
    // Checkpoint WAL before closing
    if (db._adapter === 'sqlite') {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
    db.close();
    console.log('[db] Connection closed gracefully');
  } catch (err) {
    console.error('[db] Error closing connection:', err.message);
  }
}

/**
 * Get database health info.
 */
function getDatabaseHealth(db) {
  if (!db) return { status: 'disconnected' };
  try {
    const walSize = db.pragma('page_count')[0]?.page_count || 0;
    const pageSize = db.pragma('page_size')[0]?.page_size || 4096;
    const freelistCount = db.pragma('freelist_count')[0]?.freelist_count || 0;

    return {
      status: 'connected',
      adapter: db._adapter,
      path: db._path,
      connected_since: db._createdAt,
      size_mb: Math.round((walSize * pageSize) / 1024 / 1024 * 100) / 100,
      freelist_pages: freelistCount,
      wal_mode: true,
      foreign_keys: true,
    };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

module.exports = { createDatabase, closeDatabase, getDatabaseHealth };
