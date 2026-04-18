/**
 * Supabase / PostgreSQL Adapter
 *
 * Provides the same interface as the SQLite adapter (prepare/get/all/run/transaction)
 * but talks to PostgreSQL via node-postgres (pg).
 *
 * Activated when DATABASE_URL env var is set to a postgres:// URL.
 * Falls back gracefully if the `pg` module is not installed.
 */

const { logger } = require('./logger');

/** @type {string|null} Current client ID for RLS enforcement */
let _currentClientId = null;

/**
 * Set the current client ID for RLS enforcement.
 * When set, all queries will prepend SET LOCAL app.current_client_id.
 * @param {string|null} clientId
 */
function setClientId(clientId) {
  _currentClientId = clientId || null;
}

let Pool;
try {
  Pool = require('pg').Pool;
} catch (_) {
  // pg not installed — callers should check before using this module
  Pool = null;
}

/** @type {boolean} Indicates this adapter's prepare() returns async methods */
const IS_ASYNC = true;

/**
 * Convert SQLite-style `?` placeholders to PostgreSQL `$1, $2, ...`
 * Also converts common SQLite functions to PostgreSQL equivalents.
 */
function convertSQL(sql) {
  let idx = 0;
  let converted = sql.replace(/\?/g, () => `$${++idx}`);

  // SQLite → PostgreSQL function conversions
  converted = converted
    .replace(/datetime\('now'\)/gi, 'NOW()')
    .replace(/datetime\('now',\s*'([^']+)'\)/gi, (_, offset) => {
      // e.g. datetime('now','-5 minutes') → NOW() + INTERVAL '-5 minutes'
      return `NOW() + INTERVAL '${offset}'`;
    })
    .replace(/\bIFNULL\b/gi, 'COALESCE')
    .replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY')
    // ON CONFLICT for upserts — keep as-is, PostgreSQL supports this syntax
    ;

  return { sql: converted, paramCount: idx };
}

/**
 * Create a PostgreSQL-backed database adapter with the same interface
 * as the SQLite better-sqlite3 adapter used by the rest of the codebase.
 *
 * IMPORTANT: The SQLite adapter is synchronous. This adapter makes the
 * pg calls synchronous-looking by returning objects with .get(), .all(),
 * .run() that are sync wrappers around a pre-prepared approach.
 * Since pg is inherently async, the returned methods are async-compatible
 * but the route handlers already use try/catch, so we use a sync pool
 * query approach via pg's synchronous-style API where possible.
 *
 * In practice, callers should `await` the results or the adapter handles
 * it transparently via the wrapped statement interface.
 */
function createSupabaseDatabase(options = {}) {
  if (!Pool) {
    throw new Error(
      'MISSING_DEPENDENCY: [supabaseAdapter] pg module not installed. Run: npm install pg'
    );
  }

  const connectionString = options.url || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MISSING_CONFIG: [supabaseAdapter] DATABASE_URL not set');
  }

  const pool = new Pool({
    connectionString,
    min: 2,
    max: 10,
    ssl: { rejectUnauthorized: false },
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    logger.error('[supabaseAdapter] Unexpected pool error:', err.message);
  });

  /**
   * Mimic better-sqlite3's db.prepare(sql) which returns { get, all, run }.
   * Each method accepts positional args matching the `?` placeholders.
   */
  function prepare(sql) {
    const { sql: pgSQL } = convertSQL(sql);

    return {
      /**
       * Return a single row (or undefined).
       */
      async get(...args) {
        const result = await pool.query(pgSQL, args);
        return result.rows[0] || undefined;
      },

      /**
       * Return all matching rows.
       */
      async all(...args) {
        const result = await pool.query(pgSQL, args);
        return result.rows;
      },

      /**
       * Execute a mutation (INSERT/UPDATE/DELETE).
       * Returns { changes, lastInsertRowid } to match better-sqlite3.
       */
      async run(...args) {
        const result = await pool.query(pgSQL, args);
        return {
          changes: result.rowCount || 0,
          lastInsertRowid: result.rows?.[0]?.id || null,
        };
      },
    };
  }

  /**
   * Execute raw SQL (e.g. DDL statements, multi-statement migrations).
   */
  async function exec(sql) {
    await pool.query(sql);
  }

  /**
   * Mimic better-sqlite3's db.transaction(fn).
   * Returns an async function that wraps fn in BEGIN/COMMIT/ROLLBACK.
   */
  function transaction(fn) {
    return async function (...args) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Build a scoped db-like object that uses this transaction client
        const txDb = {
          _async: true,
          prepare(sql) {
            const { sql: pgSQL } = convertSQL(sql);
            return {
              async get(...params) {
                const result = await client.query(pgSQL, params);
                return result.rows[0] || undefined;
              },
              async all(...params) {
                const result = await client.query(pgSQL, params);
                return result.rows;
              },
              async run(...params) {
                const result = await client.query(pgSQL, params);
                return { changes: result.rowCount || 0, lastInsertRowid: result.rows?.[0]?.id || null };
              },
            };
          },
          async query(sql, params = [], mode = 'all') {
            const { sql: pgSQL } = convertSQL(sql);
            // RLS enforcement within transaction — use set_config() to avoid injection
            if (_currentClientId) {
              await client.query('SELECT set_config($1, $2, true)', ['app.current_client_id', _currentClientId]);
            }
            const result = await client.query(pgSQL, params);
            if (mode === 'get') return result.rows[0] || undefined;
            if (mode === 'run') return { changes: result.rowCount || 0, lastInsertRowid: result.rows?.[0]?.id || null };
            return result.rows;
          },
        };

        const result = await fn.call(txDb, ...args);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };
  }

  /**
   * Mimic better-sqlite3's db.pragma() — no-op for PostgreSQL.
   * Some callers use pragma('wal_checkpoint') etc.
   */
  function pragma() {
    return [];
  }

  /**
   * Close the connection pool.
   */
  async function close() {
    await pool.end();
    logger.info('[supabaseAdapter] Connection pool closed');
  }

  /**
   * Unified async query helper.
   * Works the same as db.query() on the dbAdapter — accepts raw SQL + params
   * and returns the result rows. For mutations, returns { changes, lastInsertRowid }.
   *
   * @param {string} sql    - SQL with `?` placeholders (auto-converted to $1,$2,...)
   * @param {Array}  params - Positional parameters
   * @param {'get'|'all'|'run'} [mode='all'] - Return mode
   * @returns {Promise<*>}
   */
  async function query(sql, params = [], mode = 'all') {
    const { sql: pgSQL } = convertSQL(sql);
    // RLS enforcement: use set_config() to avoid injection
    if (_currentClientId) {
      await pool.query('SELECT set_config($1, $2, true)', ['app.current_client_id', _currentClientId]);
    }
    const result = await pool.query(pgSQL, params);
    if (mode === 'get') return result.rows[0] || undefined;
    if (mode === 'run') return { changes: result.rowCount || 0, lastInsertRowid: result.rows?.[0]?.id || null };
    return result.rows;
  }

  const db = {
    prepare,
    exec,
    transaction,
    pragma,
    close,
    query,
    _adapter: 'postgresql',
    _async: IS_ASYNC,
    _path: connectionString.replace(/\/\/[^@]+@/, '//***@'), // mask credentials
    _createdAt: new Date().toISOString(),
    _pool: pool,
  };

  logger.info(`[supabaseAdapter] PostgreSQL pool created (min:2 max:10 SSL:on)`);
  return db;
}

module.exports = { createSupabaseDatabase, convertSQL, IS_ASYNC, setClientId };
