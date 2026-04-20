/**
 * Database Adapter — abstracts SQLite/PostgreSQL behind a unified interface.
 *
 * IMPORTANT — SYNC vs ASYNC:
 *
 *   SQLite  (better-sqlite3): db.prepare(sql).get/all/run() are SYNCHRONOUS.
 *   Postgres (supabaseAdapter): db.prepare(sql).get/all/run() return PROMISES.
 *
 *   Existing route code calls db.prepare().get() synchronously and does NOT
 *   await the result. That works fine for SQLite but silently breaks with
 *   Postgres — the caller gets a Promise object instead of data.
 *
 *   To bridge the gap WITHOUT rewriting every route at once:
 *
 *   1. `db._async` — boolean flag. true for Postgres, false/undefined for SQLite.
 *   2. `isAsync(db)` — helper to check which mode is active.
 *   3. `db.query(sql, params, mode)` — unified async method that works on BOTH
 *      backends. For SQLite it wraps the sync call in a resolved Promise.
 *      For Postgres it delegates to the pool.
 *
 *   Migration path for routes:
 *     - Old sync code: `db.prepare(sql).get(args)` — works for SQLite only.
 *     - New async code: `await db.query(sql, [args], 'get')` — works for BOTH.
 *     - Routes should be gradually migrated to use `db.query()`.
 */

const { logger } = require('./logger');
const { getDatabasePath } = require('./dbConfig');

// ─── In-memory query result cache ────────────────────────────────────────────
// Simple Map-based cache with TTL. No external dependency.
// Designed for hot read-only lookups (clients by ID, campaigns by ID).

const _cache = new Map(); // key → { value, expiresAt }

/**
 * Get a cached value or compute it via queryFn and cache the result.
 *
 * @param {string} key       - Cache key (e.g. 'client:abc-123')
 * @param {number} ttlMs     - Time-to-live in milliseconds
 * @param {Function} queryFn - Synchronous function returning the value to cache
 * @returns {*} Cached or freshly-computed value
 */
function cachedGet(key, ttlMs, queryFn) {
  const now = Date.now();
  const entry = _cache.get(key);

  if (entry && entry.expiresAt > now) {
    return entry.value;
  }

  const value = queryFn();
  _cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Invalidate a specific cache key.
 * Call this after UPDATE or DELETE on a cached record.
 *
 * @param {string} key - Cache key to evict
 */
function invalidateCache(key) {
  _cache.delete(key);
}

/**
 * Invalidate all cache entries whose key starts with a given prefix.
 * Useful for bulk invalidation (e.g. invalidateCachePrefix('client:') on client list queries).
 *
 * @param {string} prefix
 */
function invalidateCachePrefix(prefix) {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) {
      _cache.delete(key);
    }
  }
}

/**
 * Clear all cached entries (e.g. on DB reconnect or tests).
 */
function clearCache() {
  _cache.clear();
}

// TTL constants
const CACHE_TTL = {
  CLIENT: 5 * 60 * 1000,   // 5 minutes
  CAMPAIGN: 5 * 60 * 1000, // 5 minutes
};

/**
 * Check whether a db instance uses async methods (Postgres) or sync (SQLite).
 * @param {object} db - The database object returned by createDatabase()
 * @returns {boolean}
 */
function isAsync(db) {
  return !!(db && db._async);
}

/**
 * Create and configure a database connection.
 * Returns a db object with unified interface.
 */
function createDatabase(options = {}) {
  const dbUrl = process.env.DATABASE_URL;

  // PostgreSQL mode via Supabase adapter
  // NOTE: prepare().get/all/run() return Promises. Use `await db.query()` or
  // `await db.prepare(sql).get()` in route handlers when DATABASE_URL is set.
  // Skip Postgres if DATABASE_PATH is explicitly set (SQLite takes priority)
  if (dbUrl && !process.env.DATABASE_PATH && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
    const { createSupabaseDatabase } = require('./supabaseAdapter');
    const pgDb = createSupabaseDatabase({ url: dbUrl });
    logger.info('[db] PostgreSQL mode active via supabaseAdapter (async — use await)');
    return pgDb;
  }

  // SQLite mode (current production)
  const Database = require('better-sqlite3');
  const dbPath = options.path || getDatabasePath();
  const verbose = options.verbose || (process.env.NODE_ENV === 'development' ? (...args) => logger.debug('[db:verbose]', ...args) : undefined);

  const db = new Database(dbPath, { verbose });

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000'); // Increased from 5000 for concurrent load
  db.pragma('synchronous = NORMAL'); // Faster writes, still crash-safe with WAL
  db.pragma('cache_size = -64000'); // 64MB cache (default is 2MB)
  db.pragma('temp_store = MEMORY'); // Temp tables in memory

  // Run migrations with FK checks disabled (production data has orphaned rows)
  db.pragma('foreign_keys = OFF');
  const { runMigrations } = require('./migrations');
  runMigrations(db);
  db.pragma('foreign_keys = ON');

  // Slow query logging — wrap prepare to add timing to all statement methods
  const originalPrepare = db.prepare.bind(db);
  db.prepare = function(sql) {
    const stmt = originalPrepare(sql);
    const originalRun = stmt.run.bind(stmt);
    const originalGet = stmt.get.bind(stmt);
    const originalAll = stmt.all.bind(stmt);

    const wrapWithTiming = (fn) => function(...args) {
      const start = Date.now();
      const result = fn(...args);
      const ms = Date.now() - start;
      if (ms > 100) logger.warn(`[db] Slow query (${ms}ms): ${sql.substring(0, 200)}`);
      return result;
    };

    stmt.run = wrapWithTiming(originalRun);
    stmt.get = wrapWithTiming(originalGet);
    stmt.all = wrapWithTiming(originalAll);
    return stmt;
  };

  // Attach connection metadata
  db._adapter = 'sqlite';
  db._async = false;
  db._path = dbPath;
  db._createdAt = new Date().toISOString();

  /**
   * Unified async query helper (SQLite implementation).
   * Wraps the synchronous better-sqlite3 calls so callers can use the same
   * `await db.query(sql, params, mode)` interface regardless of backend.
   *
   * @param {string} sql    - SQL with `?` placeholders
   * @param {Array}  params - Positional parameters
   * @param {'get'|'all'|'run'} [mode='all'] - Return mode
   * @returns {Promise<*>}
   */
  db.query = function query(sql, params = [], mode = 'all') {
    try {
      const stmt = db.prepare(sql);
      let result;
      if (mode === 'get') result = stmt.get(...params);
      else if (mode === 'run') result = stmt.run(...params);
      else result = stmt.all(...params);
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  };

  logger.info(`[db] SQLite connected: ${dbPath} (WAL mode, 64MB cache, FK enforced)`);
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
    logger.info('[db] Connection closed gracefully');
  } catch (err) {
    logger.error('[db] Error closing connection:', err.message);
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

module.exports = {
  createDatabase,
  closeDatabase,
  getDatabaseHealth,
  isAsync,
  // Cache helpers — use these in routes/services to avoid hot-path DB hits
  cachedGet,
  invalidateCache,
  invalidateCachePrefix,
  clearCache,
  CACHE_TTL,
};
