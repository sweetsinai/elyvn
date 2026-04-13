/**
 * Persistent Job Queue
 * SQLite-backed job queue with status tracking
 */

const { randomUUID } = require('crypto');
const { JOB_HANDLER_TIMEOUT, JOB_CLEANUP_DELAY_MS, STALLED_JOB_THRESHOLD_MS, STALE_JOB_THRESHOLD_MS, JOB_RETRY_BACKOFF_BASE_MS } = require('../config/timing');
const { logger } = require('./logger');
const { AppError } = require('./AppError');

/**
 * Ensure the dead_letter_queue table and idempotency_key column exist.
 * Called lazily on first use so no separate migration file is needed.
 * @param {object} db - better-sqlite3 instance
 */
async function ensureSchema(db) {
  // Add idempotency_key column to job_queue if it doesn't exist
  try {
    await db.query('ALTER TABLE job_queue ADD COLUMN idempotency_key TEXT', [], 'run');
  } catch (_) { /* column already exists */ }

  // Add unique index on idempotency_key (partial — only for non-null values)
  try {
    await db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_idempotency ON job_queue (idempotency_key) WHERE idempotency_key IS NOT NULL', [], 'run');
  } catch (_) { /* index already exists */ }

  // Create dead_letter_queue table
  await db.query(`
    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id TEXT PRIMARY KEY,
      original_job_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      payload TEXT,
      error TEXT,
      failed_at TEXT NOT NULL
    )
  `, [], 'run');
}

let _schemaPromise = null;
async function ensureSchemaOnce(db) {
  if (!_schemaPromise) _schemaPromise = ensureSchema(db);
  return _schemaPromise;
}

/**
 * Enqueue a job
 * @param {object} db - better-sqlite3 instance
 * @param {string} type - Job type (speed_to_lead_sms, speed_to_lead_callback, etc)
 * @param {object} payload - Job payload (JSON stringified)
 * @param {string} [scheduledAt] - ISO timestamp (defaults to now)
 * @param {string} [idempotencyKey] - Optional dedup key; if a pending/running job with this key
 *   already exists, return its ID without inserting a duplicate
 * @returns {string} Job ID (existing or new)
 */
async function enqueueJob(db, type, payload, scheduledAt = null, idempotencyKey = null, priority = 5) {
  if (!db || !type) throw new AppError('VALIDATION_ERROR', 'db and type required', 400);

  await ensureSchemaOnce(db);

  const scheduled = scheduledAt || new Date().toISOString();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  // Idempotency check: return existing job if key is already active
  if (idempotencyKey) {
    try {
      const existing = await db.query(
        "SELECT id FROM job_queue WHERE idempotency_key = ? AND status IN ('pending', 'processing') LIMIT 1",
        [idempotencyKey], 'get'
      );
      if (existing) {
        logger.info(`[jobQueue] Idempotent enqueue — returning existing job: ${existing.id}`);
        return existing.id;
      }
    } catch (err) {
      logger.warn('[jobQueue] Idempotency check error:', err.message);
    }
  }

  const jobId = randomUUID();

  try {
    await db.query(`
      INSERT INTO job_queue (id, type, payload, scheduled_at, status, attempts, max_attempts, idempotency_key, priority)
      VALUES (?, ?, ?, ?, 'pending', 0, 3, ?, ?)
    `, [jobId, type, payloadStr, scheduled, idempotencyKey || null, priority], 'run');

    logger.info(`[jobQueue] Enqueued ${type} job: ${jobId}`);
    return jobId;
  } catch (err) {
    logger.error('[jobQueue] enqueueJob error:', err.message);
    throw err;
  }
}

function executeWithTimeout(fn, timeoutMs = JOB_HANDLER_TIMEOUT) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Job handler timeout')), timeoutMs))
  ]);
}

/**
 * Process all due jobs
 * @param {object} db - better-sqlite3 instance
 * @param {object} handlers - Map of type => async handler function
 * @returns {Promise<{processed: number, failed: number}>}
 */
async function processJobs(db, handlers) {
  if (!db || !handlers) return { processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;

  try {
    // Clean up old completed/failed/cancelled jobs (older than 7 days) to prevent table bloat
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const result = await db.query(`
        DELETE FROM job_queue
        WHERE status IN ('completed', 'failed', 'cancelled')
        AND updated_at < ?
      `, [sevenDaysAgo], 'run');
      if (result.changes > 0) {
        logger.info(`[jobQueue] Cleaned up ${result.changes} old jobs`);
      }
    } catch (err) {
      logger.warn('[jobQueue] Cleanup error:', err.message);
    }

    const now = new Date().toISOString();
    const due = await db.query(`
      SELECT * FROM job_queue
      WHERE status = 'pending'
      AND datetime(scheduled_at) <= ?
      ORDER BY priority DESC, scheduled_at ASC
      LIMIT 20
    `, [now]);

    for (const job of due) {
      try {
        const handler = handlers[job.type];
        if (!handler) {
          logger.warn(`[jobQueue] No handler for job type: ${job.type}`);
          await db.query(
            "UPDATE job_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
            ['Unknown job type', now, job.id], 'run'
          );
          failed++;
          continue;
        }

        // Atomically claim the job — if another worker already claimed it, changes === 0 → skip
        const claimed = await db.query(
          "UPDATE job_queue SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'",
          [now, job.id], 'run'
        );
        if (claimed.changes === 0) continue;

        let payload = job.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch (parseErr) {
            logger.error(`[jobQueue] Failed to parse payload for job ${job.id}: ${parseErr.message}`);
            await db.query("UPDATE job_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
              ['Payload parse error: ' + parseErr.message, now, job.id], 'run');
            continue;
          }
        }

        // Execute the handler with timeout
        await executeWithTimeout(() => handler(payload, job.id, db), JOB_HANDLER_TIMEOUT);

        // Mark as completed
        await db.query(
          "UPDATE job_queue SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
          [now, now, job.id], 'run'
        );

        processed++;
        logger.info(`[jobQueue] Completed job ${job.id} (${job.type})`);
      } catch (err) {
        failed++;
        const attempts = (job.attempts || 0) + 1;

        if (attempts < job.max_attempts) {
          // Reschedule with exponential backoff
          const backoffMs = Math.pow(2, attempts) * JOB_RETRY_BACKOFF_BASE_MS; // 2min, 4min, 8min
          const nextScheduled = new Date(Date.now() + backoffMs).toISOString();
          await db.query(
            "UPDATE job_queue SET status = 'pending', attempts = ?, scheduled_at = ?, error = ?, updated_at = ? WHERE id = ?",
            [attempts, nextScheduled, err.message.substring(0, 255), now, job.id], 'run'
          );

          logger.warn(`[jobQueue] Job ${job.id} failed (attempt ${attempts}/${job.max_attempts}), rescheduled`);
        } else {
          // Move to dead letter queue before marking as failed
          try {
            await ensureSchemaOnce(db);
            await db.query(`
              INSERT INTO dead_letter_queue (id, original_job_id, job_type, payload, error, failed_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `, [randomUUID(), job.id, job.type, job.payload, err.message.substring(0, 1000), now], 'run');
          } catch (dlqErr) {
            logger.error('[jobQueue] DLQ insert failed:', dlqErr.message);
          }

          // Mark as permanently failed
          await db.query(
            "UPDATE job_queue SET status = 'failed', error = ?, failed_at = ?, updated_at = ? WHERE id = ?",
            [err.message.substring(0, 255), now, now, job.id], 'run'
          );

          logger.error(`[jobQueue] Job ${job.id} permanently failed (moved to DLQ):`, err.message);
        }
      }

      // Small delay between jobs
      await new Promise(r => setTimeout(r, JOB_CLEANUP_DELAY_MS));
    }

    // Record queue health metrics after each cycle
    try {
      const { recordMetric } = require('./metrics');
      const [pendingRow, processingRow] = await Promise.all([
        db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'", [], 'get'),
        db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'processing'", [], 'get'),
      ]);
      recordMetric('job_queue_pending', pendingRow?.c || 0, 'gauge');
      recordMetric('job_queue_processing', processingRow?.c || 0, 'gauge');
    } catch (_) { /* metrics recording must not break job processing */ }

    return { processed, failed };
  } catch (err) {
    logger.error('[jobQueue] processJobs error:', err.message);
    return { processed, failed };
  }
}

/**
 * Cancel pending jobs matching filter
 * @param {object} db - better-sqlite3 instance
 * @param {object} filter - Query filter {type?, leadId?, clientId?, etc}
 * @returns {number} Count of cancelled jobs
 */
async function cancelJobs(db, filter) {
  if (!db || !filter) return 0;

  try {
    let where = "status = 'pending'";
    const params = [];

    if (filter.type) {
      where += ' AND type = ?';
      params.push(filter.type);
    }

    if (filter.payloadContains) {
      // Escape SQL LIKE wildcards to prevent pattern injection
      const escaped = filter.payloadContains.replace(/[%_\\]/g, '\\$&');
      where += " AND payload LIKE ? ESCAPE '\\'";
      params.push(`%${escaped}%`);
    }

    const result = await db.query(
      `UPDATE job_queue SET status = 'cancelled' WHERE ${where}`,
      params, 'run'
    );

    logger.info(`[jobQueue] Cancelled ${result.changes} pending jobs`);
    return result.changes || 0;
  } catch (err) {
    logger.error('[jobQueue] cancelJobs error:', err.message);
    return 0;
  }
}

/**
 * Recover stalled jobs on startup
 * Handles two scenarios:
 * 1. Jobs stuck in 'processing' status from a crash (>30 minutes)
 * 2. Jobs stuck in 'pending' status for > 1 hour (likely missed the processing window)
 * @param {object} db - better-sqlite3 instance
 * @returns {Promise<{recovered: number, stalePendingFailed: number}>}
 */
async function recoverStalledJobs(db) {
  if (!db) return { recovered: 0, stalePendingFailed: 0 };

  // Ensure DLQ table and idempotency_key column exist at startup
  await ensureSchemaOnce(db);

  try {
    let totalRecovered = 0;
    let stalePendingFailed = 0;

    // Recover jobs stuck in 'processing' status (crash scenario)
    // Only recover if they've been stuck for > STALLED_JOB_THRESHOLD_MS
    const now = new Date().toISOString();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const processingResult = await db.query(`
      UPDATE job_queue
      SET status = 'pending', attempts = attempts + 1, updated_at = ?
      WHERE status = 'processing' AND updated_at < ?
    `, [now, thirtyMinAgo], 'run');

    if (processingResult.changes > 0) {
      logger.info(`[jobQueue] Recovered ${processingResult.changes} jobs stuck in 'processing' status (crash recovery)`);
      totalRecovered += processingResult.changes;
    }

    // Recover stale pending jobs older than 1 hour — these missed their window
    // Jobs with remaining retries get reset; exhausted jobs get failed
    const stalePending = await db.query(`
      SELECT id, type, payload, attempts, max_attempts FROM job_queue
      WHERE status = 'pending' AND updated_at < ?
    `, [oneHourAgo]);

    for (const job of stalePending) {
      if ((job.attempts || 0) < (job.max_attempts || 3)) {
        // Reset with warning — give it another chance
        await db.query(
          "UPDATE job_queue SET attempts = attempts + 1, scheduled_at = ?, updated_at = ? WHERE id = ?",
          [now, now, job.id], 'run'
        );
        totalRecovered++;
        logger.warn(`[jobQueue] Reset stale pending job ${job.id} (${job.type}) — was pending > 1 hour`);
      } else {
        // Exhausted retries — move to DLQ and mark failed
        try {
          await db.query(`
            INSERT INTO dead_letter_queue (id, original_job_id, job_type, payload, error, failed_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [randomUUID(), job.id, job.type, job.payload, 'Stale pending job exceeded max attempts', now], 'run');
        } catch (dlqErr) {
          logger.error('[jobQueue] DLQ insert failed for stale job:', dlqErr.message);
        }
        await db.query(
          "UPDATE job_queue SET status = 'failed', error = 'Stale pending > 1 hour, max attempts exhausted', failed_at = ?, updated_at = ? WHERE id = ?",
          [now, now, job.id], 'run'
        );
        stalePendingFailed++;
        logger.warn(`[jobQueue] Failed stale pending job ${job.id} (${job.type}) — max attempts exhausted`);
      }
    }

    if (totalRecovered > 0 || stalePendingFailed > 0) {
      logger.info(`[jobQueue] Startup recovery: ${totalRecovered} recovered, ${stalePendingFailed} stale pending failed`);
    }

    return { recovered: totalRecovered, stalePendingFailed };
  } catch (err) {
    logger.error('[jobQueue] recoverStalledJobs error:', err.message);
    return { recovered: 0, stalePendingFailed: 0 };
  }
}

/**
 * Get queue health metrics
 * @param {object} db - better-sqlite3 instance
 * @returns {Promise<{pending: number, processing: number, failed: number, dlq: number, oldest_pending_age_minutes: number}>}
 */
async function getQueueHealth(db) {
  if (!db) return { pending: 0, processing: 0, failed: 0, dlq: 0, oldest_pending_age_minutes: 0 };

  try {
    await ensureSchemaOnce(db);

    const [pendingRow, processingRow, failedRow, dlqRow, oldestRow] = await Promise.all([
      db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'", [], 'get'),
      db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'processing'", [], 'get'),
      db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'failed'", [], 'get'),
      db.query("SELECT COUNT(*) as c FROM dead_letter_queue", [], 'get'),
      db.query("SELECT MIN(created_at) as oldest FROM job_queue WHERE status = 'pending'", [], 'get'),
    ]);

    let oldestAgeMinutes = 0;
    if (oldestRow?.oldest) {
      oldestAgeMinutes = Math.round((Date.now() - new Date(oldestRow.oldest).getTime()) / 60000);
    }

    return {
      pending: pendingRow?.c || 0,
      processing: processingRow?.c || 0,
      failed: failedRow?.c || 0,
      dlq: dlqRow?.c || 0,
      oldest_pending_age_minutes: oldestAgeMinutes,
    };
  } catch (err) {
    logger.error('[jobQueue] getQueueHealth error:', err.message);
    return { pending: 0, processing: 0, failed: 0, dlq: 0, oldest_pending_age_minutes: 0 };
  }
}

/**
 * Return all dead letter queue entries for inspection.
 * @param {object} db - better-sqlite3 instance
 * @returns {Array} DLQ entries ordered by failed_at desc
 */
async function getDLQ(db) {
  if (!db) return [];
  try {
    await ensureSchemaOnce(db);
    return await db.query('SELECT * FROM dead_letter_queue ORDER BY failed_at DESC');
  } catch (err) {
    logger.error('[jobQueue] getDLQ error:', err.message);
    return [];
  }
}

function _resetSchemaForTesting() {
  _schemaPromise = null;
}

module.exports = { enqueueJob, processJobs, cancelJobs, recoverStalledJobs, getDLQ, getQueueHealth, _resetSchemaForTesting };
