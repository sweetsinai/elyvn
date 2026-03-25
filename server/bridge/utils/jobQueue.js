/**
 * Persistent Job Queue
 * SQLite-backed job queue with status tracking
 */

const { randomUUID } = require('crypto');

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

    console.log(`[jobQueue] Enqueued ${type} job: ${jobId}`);
    return jobId;
  } catch (err) {
    console.error('[jobQueue] enqueueJob error:', err.message);
    throw err;
  }
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
        console.log(`[jobQueue] Cleaned up ${result.changes} old jobs`);
      }
    } catch (err) {
      console.warn('[jobQueue] Cleanup error:', err.message);
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
          console.warn(`[jobQueue] No handler for job type: ${job.type}`);
          db.prepare(
            "UPDATE job_queue SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?"
          ).run('Unknown job type', job.id);
          failed++;
          continue;
        }

        let payload = job.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch (_) {
            // Keep as string if parse fails
          }
        }

        // Execute the handler
        await handler(payload, job.id, db);

        // Mark as completed
        db.prepare(
          "UPDATE job_queue SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).run(job.id);

        processed++;
        console.log(`[jobQueue] Completed job ${job.id} (${job.type})`);
      } catch (err) {
        failed++;
        const attempts = (job.attempts || 0) + 1;

        if (attempts < job.max_attempts) {
          // Reschedule with exponential backoff
          const backoffMs = Math.pow(2, attempts) * 60 * 1000; // 2^n minutes
          const nextScheduled = new Date(Date.now() + backoffMs).toISOString();
          db.prepare(
            "UPDATE job_queue SET attempts = ?, scheduled_at = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(attempts, nextScheduled, err.message.substring(0, 255), job.id);

          console.warn(`[jobQueue] Job ${job.id} failed (attempt ${attempts}/${job.max_attempts}), rescheduled`);
        } else {
          // Mark as permanently failed
          db.prepare(
            "UPDATE job_queue SET status = 'failed', error = ?, failed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          ).run(err.message.substring(0, 255), job.id);

          console.error(`[jobQueue] Job ${job.id} permanently failed:`, err.message);
        }
      }

      // Small delay between jobs
      await new Promise(r => setTimeout(r, 100));
    }

    return { processed, failed };
  } catch (err) {
    console.error('[jobQueue] processJobs error:', err.message);
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
      where += " AND payload LIKE ?";
      params.push(`%${filter.payloadContains}%`);
    }

    const result = db.prepare(
      `UPDATE job_queue SET status = 'cancelled' WHERE ${where}`
    ).run(...params);

    console.log(`[jobQueue] Cancelled ${result.changes} pending jobs`);
    return result.changes || 0;
  } catch (err) {
    console.error('[jobQueue] cancelJobs error:', err.message);
    return 0;
  }
}

module.exports = { enqueueJob, processJobs, cancelJobs };
