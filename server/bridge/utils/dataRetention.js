/**
 * Data Retention Policy — prevents tables from growing forever.
 * Run daily via scheduler.
 */

const { logger } = require('./logger');
const { randomUUID } = require('crypto');

// Allowlist of permitted table names — prevents SQL injection if policies are ever loaded externally
const ALLOWED_TABLES = new Set(['job_queue', 'audit_log', 'messages', 'followups', 'calls', 'leads']);

// Pre-built parameterized DELETE queries per table — no string interpolation of conditions
const RETENTION_POLICIES = {
  job_queue: {
    countSQL: "SELECT COUNT(*) as c FROM job_queue WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?",
    deleteSQL: "DELETE FROM job_queue WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?",
    cutoff: (days = 30) => new Date(Date.now() - days * 86400000).toISOString(),
    days: 30,
  },
  audit_log: {
    countSQL: 'SELECT COUNT(*) as c FROM audit_log WHERE created_at < ?',
    deleteSQL: 'DELETE FROM audit_log WHERE created_at < ?',
    cutoff: (days = 180) => new Date(Date.now() - days * 86400000).toISOString(),
    days: 180,
  },
  messages: {
    countSQL: 'SELECT COUNT(*) as c FROM messages WHERE created_at < ?',
    deleteSQL: 'DELETE FROM messages WHERE created_at < ?',
    cutoff: (days = 90) => new Date(Date.now() - days * 86400000).toISOString(),
    days: 90,
  },
  followups: {
    countSQL: "SELECT COUNT(*) as c FROM followups WHERE status IN ('completed', 'sent') AND updated_at < ?",
    deleteSQL: "DELETE FROM followups WHERE status IN ('completed', 'sent') AND updated_at < ?",
    cutoff: (days = 90) => new Date(Date.now() - days * 86400000).toISOString(),
    days: 90,
  },
  calls: {
    countSQL: 'SELECT COUNT(*) as c FROM calls WHERE created_at < ?',
    deleteSQL: 'DELETE FROM calls WHERE created_at < ?',
    cutoff: (days = 365) => new Date(Date.now() - days * 86400000).toISOString(),
    days: 365,
  },
  leads: {
    countSQL: "SELECT COUNT(*) as c FROM leads WHERE stage IN ('lost', 'completed') AND updated_at < ?",
    deleteSQL: "DELETE FROM leads WHERE stage IN ('lost', 'completed') AND updated_at < ?",
    cutoff: (days = 365) => new Date(Date.now() - days * 86400000).toISOString(),
    days: 365,
  },
};

/**
 * Write a retention-deletion event to audit_log.
 * Skips gracefully if audit_log itself doesn't exist or can't be written.
 * @param {object} db - better-sqlite3 instance
 * @param {string} table - Table that was cleaned
 * @param {number} rowsDeleted - Number of rows removed
 */
async function _logRetentionToAudit(db, table, rowsDeleted) {
  try {
    const auditExists = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'", [], 'get');
    if (!auditExists) return;

    await db.query(`
      INSERT INTO audit_log (id, client_id, user_id, action, resource_type, resource_id, ip_address, user_agent, details, created_at)
      VALUES (?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, datetime('now'))
    `, [
      randomUUID(),
      'data_retention_deletion',
      table,
      JSON.stringify({ table, rows_deleted: rowsDeleted, policy: RETENTION_POLICIES[table]?.condition })
    ], 'run');
  } catch (err) {
    // Non-fatal — retention must not fail just because audit logging failed
    logger.warn(`[retention] Could not write audit log for ${table} cleanup: ${err.message}`);
  }
}

/**
 * Run data retention cleanup
 * @param {object} db - better-sqlite3 instance
 * @returns {object} Results of deletion operations
 */
async function runRetention(db) {
  if (!db) return { deleted: {} };
  const results = {};

  for (const [table, policy] of Object.entries(RETENTION_POLICIES)) {
    // Enforce table allowlist — guard against policy injection
    if (!ALLOWED_TABLES.has(table)) {
      logger.warn(`[retention] Skipping non-allowlisted table: ${table}`);
      continue;
    }

    try {
      // Check if table exists first (SQLite only — Postgres always has the table)
      if (!db._async) {
        const exists = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table], 'get');
        if (!exists) continue;
      }

      const cutoffDate = policy.cutoff();
      const count = await db.query(policy.countSQL, [cutoffDate], 'get');
      if (count.c > 0) {
        if (db._async) {
          // PostgreSQL path: explicit BEGIN/COMMIT/ROLLBACK
          await db.query('BEGIN', [], 'run');
          try {
            const result = await db.query(policy.deleteSQL, [cutoffDate], 'run');
            await _logRetentionToAudit(db, table, result.changes);
            await db.query('COMMIT', [], 'run');
            results[table] = result.changes;
            logger.info(`[retention] Deleted ${result.changes} rows from ${table}`);
          } catch (err) {
            await db.query('ROLLBACK', [], 'run');
            logger.error(`[retention] Failed to clean ${table}:`, err.message);
            results[table] = { error: err.message };
          }
        } else {
          // SQLite path: use synchronous transaction
          db.transaction(() => {
            const result = db.prepare(policy.deleteSQL).run(cutoffDate);
            results[table] = result.changes;
            logger.info(`[retention] Deleted ${result.changes} rows from ${table}`);
          })();
          if (typeof results[table] === 'number' && results[table] > 0) {
            await _logRetentionToAudit(db, table, results[table]);
          }
        }
      }
    } catch (err) {
      logger.error(`[retention] Error on ${table}:`, err.message);
      results[table] = { error: err.message };
    }
  }

  // VACUUM to reclaim space (only if we deleted significant data)
  const totalDeleted = Object.values(results).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
  if (totalDeleted > 1000) {
    try {
      db.exec('VACUUM');
      logger.info('[retention] VACUUM completed');
    } catch (err) {
      logger.error('[retention] VACUUM error:', err.message);
    }
  }

  return { deleted: results };
}

module.exports = { runRetention, RETENTION_POLICIES };
