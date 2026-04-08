/**
 * Outbound Webhook Retry Queue
 *
 * File-backed queue for delivering outbound HTTP notifications to client-configured
 * callback URLs (booking confirmations, lead alerts, CRM webhooks, etc.).
 *
 * Features:
 *   - Persistent across restarts (JSON file-backed)
 *   - Exponential backoff: immediate → 1 min → 5 min → 15 min → 1 hour
 *   - Up to MAX_RETRIES delivery attempts before permanent failure
 *   - Idempotent: uses a stable per-entry id for dedup
 *   - HMAC-SHA256 signature header for receiver verification
 *
 * Usage:
 *   const { enqueue } = require('./webhookQueue');
 *   await enqueue('https://client.example.com/hook', { event: 'booking.created', ... });
 *
 * Startup wiring (in config/startup.js initializeServer):
 *   const { startProcessor } = require('../utils/webhookQueue');
 *   startProcessor();
 */

const fs = require('fs');
const path = require('path');
const { randomUUID, createHmac } = require('crypto');
const { logger } = require('./logger');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QUEUE_PATH = path.resolve(__dirname, '../data/webhook-queue.json');
const MAX_RETRIES = 5;
// Backoff delays in seconds: immediate, 1m, 5m, 15m, 1h
const BACKOFF_SECONDS = [0, 60, 300, 900, 3600];
const DELIVERY_TIMEOUT_MS = 10000; // 10 s per attempt
const PROCESSOR_INTERVAL_MS = 60 * 1000; // run every 60 s

// ---------------------------------------------------------------------------
// Queue I/O helpers
// ---------------------------------------------------------------------------

/** @returns {Array} Parsed queue entries, or [] on any read/parse error */
function readQueue() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn('[webhookQueue] Failed to read queue file:', err.message);
    return [];
  }
}

/** @param {Array} entries - Full queue to persist */
function writeQueue(entries) {
  try {
    // Ensure data dir exists
    const dir = path.dirname(QUEUE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    logger.error('[webhookQueue] Failed to write queue file:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public: enqueue
// ---------------------------------------------------------------------------

/**
 * Add a delivery task to the outbound webhook queue.
 *
 * @param {string} url     - Full HTTPS URL of the client callback endpoint
 * @param {object} payload - Event data to POST as JSON
 * @param {object} [headers={}] - Extra headers to include (e.g. X-Client-Id)
 * @returns {string} id of the queued entry
 */
async function enqueue(url, payload, headers = {}) {
  if (!url || typeof url !== 'string') {
    logger.warn('[webhookQueue] enqueue called with invalid url, skipping');
    return null;
  }

  const entry = {
    id: randomUUID(),
    url,
    payload,
    headers,
    attempts: 0,
    retryAfter: new Date().toISOString(), // due immediately
    createdAt: new Date().toISOString(),
    lastError: null,
  };

  const queue = readQueue();
  queue.push(entry);
  writeQueue(queue);

  logger.info(`[webhookQueue] Enqueued delivery ${entry.id} → ${url}`);
  return entry.id;
}

// ---------------------------------------------------------------------------
// Delivery helper
// ---------------------------------------------------------------------------

/**
 * Attempt a single HTTP POST delivery.
 * Adds an HMAC-SHA256 X-Elyvn-Signature header when WEBHOOK_SIGNING_SECRET is set.
 *
 * @returns {{ ok: boolean, status?: number, error?: string }}
 */
async function deliver(entry) {
  const body = JSON.stringify(entry.payload);

  const outHeaders = {
    'Content-Type': 'application/json',
    'X-Elyvn-Webhook-Id': entry.id,
    'X-Elyvn-Delivery-Attempt': String(entry.attempts + 1),
    ...entry.headers,
  };

  // Sign the payload when a secret is configured
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  if (secret) {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    outHeaders['X-Elyvn-Signature'] = `sha256=${sig}`;
  }

  try {
    const res = await fetch(entry.url, {
      method: 'POST',
      headers: outHeaders,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (res.ok) {
      return { ok: true, status: res.status };
    }

    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Public: processQueue
// ---------------------------------------------------------------------------

/**
 * Process all due queue entries.
 * - Entries with retryAfter <= now are attempted.
 * - On failure, retryAfter is advanced using BACKOFF_SECONDS.
 * - Entries that exceed MAX_RETRIES are permanently removed from the queue.
 *
 * @returns {{ attempted: number, succeeded: number, failed: number, dropped: number }}
 */
async function processQueue() {
  const queue = readQueue();
  if (queue.length === 0) return { attempted: 0, succeeded: 0, failed: 0, dropped: 0 };

  const now = Date.now();
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let dropped = 0;

  const remaining = [];

  for (const entry of queue) {
    // Not yet due — keep in queue unchanged
    if (new Date(entry.retryAfter).getTime() > now) {
      remaining.push(entry);
      continue;
    }

    attempted++;
    const result = await deliver(entry);

    if (result.ok) {
      succeeded++;
      logger.info(`[webhookQueue] Delivered ${entry.id} → ${entry.url} (attempt ${entry.attempts + 1})`);
      // Entry is removed from queue on success (not pushed to remaining)
    } else {
      const nextAttempt = entry.attempts + 1;

      if (nextAttempt >= MAX_RETRIES) {
        // Permanently failed — log and discard
        dropped++;
        logger.error(
          `[webhookQueue] Permanently failed ${entry.id} → ${entry.url} after ${nextAttempt} attempts. Last error: ${result.error}`
        );
      } else {
        // Schedule retry with backoff
        const backoffSec = BACKOFF_SECONDS[nextAttempt] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
        const retryAt = new Date(now + backoffSec * 1000).toISOString();
        failed++;
        remaining.push({
          ...entry,
          attempts: nextAttempt,
          retryAfter: retryAt,
          lastError: result.error,
        });
        logger.warn(
          `[webhookQueue] Delivery failed ${entry.id} (attempt ${nextAttempt}/${MAX_RETRIES}), retry at ${retryAt}. Error: ${result.error}`
        );
      }
    }
  }

  writeQueue(remaining);

  if (attempted > 0) {
    logger.info(`[webhookQueue] Cycle: attempted=${attempted}, ok=${succeeded}, failed=${failed}, dropped=${dropped}, queued=${remaining.length}`);
  }

  return { attempted, succeeded, failed, dropped };
}

// ---------------------------------------------------------------------------
// Public: startProcessor / stopProcessor
// ---------------------------------------------------------------------------

let _processorTimer = null;

/**
 * Start the background processor that runs processQueue every 60 seconds.
 * Safe to call multiple times — only one timer is active at a time.
 */
function startProcessor() {
  if (_processorTimer) return;

  // Run once immediately on startup to clear any backlog
  processQueue().catch(err => logger.error('[webhookQueue] Startup processing error:', err.message));

  _processorTimer = setInterval(() => {
    processQueue().catch(err => logger.error('[webhookQueue] Processing error:', err.message));
  }, PROCESSOR_INTERVAL_MS);

  logger.info('[webhookQueue] Background processor started (interval: 60s)');
}

/**
 * Stop the background processor (called during graceful shutdown).
 */
function stopProcessor() {
  if (_processorTimer) {
    clearInterval(_processorTimer);
    _processorTimer = null;
    logger.info('[webhookQueue] Background processor stopped');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  enqueue,
  processQueue,
  startProcessor,
  stopProcessor,
  // Exported for testing
  _getQueuePath: () => QUEUE_PATH,
};
