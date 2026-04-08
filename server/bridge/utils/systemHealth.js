/**
 * System Health Utilities
 * Reusable helpers for health checks: database latency, memory status, job queue stats.
 */

'use strict';

const MEMORY_WARN_THRESHOLD = 0.8; // warn when heapUsed > 80% of heapTotal

/**
 * Run a trivial SELECT 1 against the DB and measure round-trip latency.
 * @param {object} db - db adapter with .query()
 * @returns {Promise<{ status: 'ok'|'error', latencyMs: number, error?: string }>}
 */
async function checkDatabaseHealth(db) {
  if (!db) return { status: 'error', latencyMs: null, error: 'db not initialized' };
  const start = Date.now();
  try {
    await db.query('SELECT 1', [], 'get');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Return current heap usage with a status flag.
 * @returns {{ heapUsed: number, heapTotal: number, rss: number, status: 'ok'|'warning' }}
 */
function getMemoryStatus() {
  const mem = process.memoryUsage();
  const ratio = mem.heapUsed / mem.heapTotal;
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    status: ratio < MEMORY_WARN_THRESHOLD ? 'ok' : 'warning',
  };
}

/**
 * Count pending and failed jobs in the job_queue table.
 * @param {object} db - db adapter with .query()
 * @returns {Promise<{ status: 'ok'|'error', pendingJobs: number, failedJobs: number, error?: string }>}
 */
async function getJobQueueStats(db) {
  if (!db) return { status: 'error', pendingJobs: 0, failedJobs: 0, error: 'db not initialized' };
  try {
    const [pendingRow, failedRow] = await Promise.all([
      db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'", [], 'get'),
      db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'failed'", [], 'get'),
    ]);
    return {
      status: 'ok',
      pendingJobs: pendingRow?.c ?? 0,
      failedJobs: failedRow?.c ?? 0,
    };
  } catch (err) {
    return { status: 'error', pendingJobs: 0, failedJobs: 0, error: err.message };
  }
}

module.exports = { checkDatabaseHealth, getMemoryStatus, getJobQueueStats };
