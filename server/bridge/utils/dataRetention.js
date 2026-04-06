/**
 * Data Retention Policy — prevents tables from growing forever.
 * Run daily via scheduler.
 */

const { logger } = require('./logger');

const RETENTION_POLICIES = {
  // Keep completed jobs for 30 days
  job_queue: { condition: "status IN ('completed', 'failed', 'cancelled') AND updated_at < datetime('now', '-30 days')" },
  // Archive old audit logs after 90 days
  audit_log: { condition: "created_at < datetime('now', '-90 days')" },
  // Clean up old messages (keep 6 months)
  messages: { condition: "created_at < datetime('now', '-180 days')", archive: true },
};

/**
 * Run data retention cleanup
 * @param {object} db - better-sqlite3 instance
 * @returns {object} Results of deletion operations
 */
function runRetention(db) {
  if (!db) return { deleted: {} };
  const results = {};

  for (const [table, policy] of Object.entries(RETENTION_POLICIES)) {
    try {
      // Check if table exists first
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) continue;

      const count = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${policy.condition}`).get();
      if (count.c > 0) {
        const result = db.prepare(`DELETE FROM ${table} WHERE ${policy.condition}`).run();
        results[table] = result.changes;
        logger.info(`[retention] Deleted ${result.changes} rows from ${table}`);
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
