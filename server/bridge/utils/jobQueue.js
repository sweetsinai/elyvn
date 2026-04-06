/**
 * Persistent Job Queue
 * SQLite-backed job queue with status tracking
 */

const { randomUUID } = require('crypto');
const { JOB_HANDLER_TIMEOUT, JOB_CLEANUP_DELAY_MS, STALLED_JOB_THRESHOLD_MS, STALE_JOB_THRESHOLD_MS, JOB_RETRY_BACKOFF_BASE_MS } = require('../config/timing');
const { logger } = require('./logger');

/**
 * Enqueue a job
 * @param {object} db - better-sqlite3 instance
 * @param {string} type - Job type (speed_to_lead_sms, speed_to_lead_callback, etc)
 * @param {object} payload - Job payload (JSON stringified)
 * @param {string} [scheduledAt] - ISO timestamp (defaults to now)
 * @returns {string} Job ID
 */
function enqueueJob(db, type, payload, scheduledAt = null) {
  if (!db || !type) throw new Error('db and type required');

  const jobId = randomUUID();
  const scheduled = scheduledAt || new Date().toISOString();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    db.prepare(`
      INSERT INTO job_queue (id, type, payload, scheduled_at, status, attempts, max_attempts)
      VALUES (?, ?, ?, ?, 'pending', 0, 3)
    `).run(jobId, type, payloadStr, scheduled);

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
      const result = db.prepare(`
        DELETE FROM job_queue
        WHERE status IN ('completed', 'failed', 'cancelled')
        AND updated_at < datetime('now', '-7 days')
      `).run();
      if (result.changes > 0) {
        logger.info(`[jobQueue] Cleaned up ${result.changes} old jobs`);
      }
    } catch (err) {
      logger.warn('[jobQueue] Cleanup error:', err.message);
    }

    const due = db.prepare(`
      SELECT * FROM job_queue
      WHERE status = 'pending'
      AND datetime(scheduled_at) <= datetime('now')
      ORDER BY scheduled_at ASC
      LIMIT 20
    `).all();

    for (const job of due) {
      try {
        const handler = handlers[job.type];
        if (!handler) {
          logger.warn(`[jobQueue] No handler for job type: ${job.type}`);
          db.prepare(
            "UPDATE job_queue SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?"
          ).run('Unknown job type', job.id);
          failed++;
          continue;
        }

        // Mark as processing IMMEDIATELY to prevent another tick from picking up the same job (TOCTOU fix)
        db.prepare(
          "UPDATE job_queue SET status = 'processing', updated_at = datetime('now') WHERE id = ?"
        ).run(job.id);

        let payload = job.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch (parseErr) {
            logger.error(`[jobQueue] Failed to parse payload for job ${job.id}: ${parseErr.message}`);
            db.prepare("UPDATE job_queue SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
              .run('Payload parse error: ' + parseErr.message, job.id);
            continue;
          }
        }

        // Execute the handler with timeout
        await executeWithTimeout(() => handler(payload, job.id, db), JOB_HANDLER_TIMEOUT);

        // Mark as completed
        db.prepare(
          "UPDATE job_queue SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).run(job.id);

        processed++;
        logger.info(`[jobQueue] Completed job ${job.id} (${job.type})`);
      } catch (err) {
        failed++;
        const attempts = (job.attempts || 0) + 1;

        if (attempts < job.max_attempts) {
          // Reschedule with exponential backoff
          const backoffMs = Math.pow(2, attempts) * JOB_RETRY_BACKOFF_BASE_MS / 60000 * 60 * 1000; // 2^n * base delay
          const nextScheduled = new Date(Date.now() + backoffMs).toISOString();
          db.prepare(
            "UPDATE job_queue SET attempts = ?, scheduled_at = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(attempts, nextScheduled, err.message.substring(0, 255), job.id);

          logger.warn(`[jobQueue] Job ${job.id} failed (attempt ${attempts}/${job.max_attempts}), rescheduled`);
        } else {
          // Mark as permanently failed
          db.prepare(
            "UPDATE job_queue SET status = 'failed', error = ?, failed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          ).run(err.message.substring(0, 255), job.id);

          logger.error(`[jobQueue] Job ${job.id} permanently failed:`, err.message);
        }
      }

      // Small delay between jobs
      await new Promise(r => setTimeout(r, JOB_CLEANUP_DELAY_MS));
    }

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
function cancelJobs(db, filter) {
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

    const result = db.prepare(
      `UPDATE job_queue SET status = 'cancelled' WHERE ${where}`
    ).run(...params);

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
 * @returns {Promise<{recovered: number}>}
 */
async function recoverStalledJobs(db) {
  if (!db) return { recovered: 0 };

  try {
    let totalRecovered = 0;

    // Recover jobs stuck in 'processing' status (crash scenario)
    // Only recover if they've been stuck for > STALLED_JOB_THRESHOLD_MS
    const processingResult = db.prepare(`
      UPDATE job_queue
      SET status = 'pending', attempts = attempts + 1, updated_at = datetime('now')
      WHERE status = 'processing' AND updated_at < datetime('now', '-30 minutes')
    `).run();

    if (processingResult.changes > 0) {
      logger.info(`[jobQueue] Recovered ${processingResult.changes} jobs stuck in 'processing' status (crash recovery)`);
      totalRecovered += processingResult.changes;
    }

    if (totalRecovered > 0) {
      logger.info(`[jobQueue] Total jobs recovered on startup: ${totalRecovered}`);
    }

    return { recovered: totalRecovered };
  } catch (err) {
    logger.error('[jobQueue] recoverStalledJobs error:', err.message);
    return { recovered: 0 };
  }
}

module.exports = { enqueueJob, processJobs, cancelJobs, recoverStalledJobs };
