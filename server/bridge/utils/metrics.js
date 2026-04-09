/**
 * Monitoring & Health Metrics
 * Lightweight in-memory metrics collector with periodic DB flush and threshold alerting.
 */

const { randomUUID } = require('crypto');
const { logger } = require('./logger');
// Lazy-load to avoid circular dependency (startup.js → metrics.js → startup.js)
function getAlertCriticalError() {
  try { return require('../config/startup').alertCriticalError; } catch (_) { return null; }
}

// Sliding window ring buffer for accurate error rate over 5 minutes.
// Each entry: { timestamp, isError }
const SLIDING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RING_SIZE = 10000; // cap memory — oldest entries evicted when full
const _ringBuffer = [];
let _ringHead = 0; // next write position when buffer is full (circular overwrite)
let _ringFull = false;

/**
 * Record a request in the sliding window ring buffer.
 * @param {boolean} isError - whether this request was an error
 */
function _recordSlidingRequest(isError) {
  const entry = { timestamp: Date.now(), isError };
  if (!_ringFull) {
    _ringBuffer.push(entry);
    if (_ringBuffer.length >= MAX_RING_SIZE) {
      _ringFull = true;
      _ringHead = 0;
    }
  } else {
    _ringBuffer[_ringHead] = entry;
    _ringHead = (_ringHead + 1) % MAX_RING_SIZE;
  }
}

/**
 * Compute error rate from the sliding window.
 * @returns {number} error rate as a percentage (0-100), 2 decimal places
 */
function getSlidingErrorRate() {
  const cutoff = Date.now() - SLIDING_WINDOW_MS;
  let total = 0;
  let errors = 0;
  const len = _ringFull ? MAX_RING_SIZE : _ringBuffer.length;
  for (let i = 0; i < len; i++) {
    const entry = _ringBuffer[i];
    if (entry.timestamp >= cutoff) {
      total++;
      if (entry.isError) errors++;
    }
  }
  if (total === 0) return 0;
  return parseFloat(((errors / total) * 100).toFixed(2));
}

const metrics = {
  total_calls: 0,
  total_sms_sent: 0,
  total_sms_failed: 0,
  total_brain_decisions: 0,
  total_errors: 0,
  active_clients: 0,
  avg_response_time_ms: 0,
  _response_times: [],
  _last_reset: new Date(),
  // Rolling 5-minute error window for threshold alerting
  _recent_errors: [],
  _recent_requests: [],
};

// DB reference — set by initMetricsFlush() once the db is available
let _db = null;

/**
 * Initialize DB schema and start periodic flush + threshold alerting.
 * Call once at startup after the DB is ready.
 * @param {object} db - better-sqlite3 instance
 */
async function initMetricsFlush(db) {
  _db = db;

  // Create snapshot table if it doesn't exist
  await db.query(`
    CREATE TABLE IF NOT EXISTS monitoring_snapshots (
      id TEXT PRIMARY KEY,
      metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL,
      labels TEXT,
      snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `, [], 'run');

  // Flush snapshot every 5 minutes
  setInterval(() => flushMetricsSnapshot(), 5 * 60 * 1000);

  // Run threshold checks every 5 minutes
  setInterval(() => checkThresholds(), 5 * 60 * 1000);
}

/**
 * Persist current metric values to the DB as a snapshot.
 * Wrapped in setImmediate so the flush never blocks the event loop.
 */
function flushMetricsSnapshot() {
  if (!_db) return;
  setImmediate(async () => {
    try {
      const snapshot = getMetrics();
      const now = snapshot.timestamp;
      const entries = Object.entries(snapshot);
      for (const [name, value] of entries) {
        if (typeof value === 'number') {
          await _db.query(
            'INSERT INTO monitoring_snapshots (id, metric_name, metric_value, labels, snapshot_at) VALUES (?, ?, ?, ?, ?)',
            [randomUUID(), name, value, null, now],
            'run'
          );
        }
      }
    } catch (err) {
      logger.error('[metrics] Failed to flush snapshot:', err.message);
    }
  });
}

/**
 * Check error_rate and queue depth thresholds; log CRITICAL/WARNING alerts.
 */
function checkThresholds() {
  const WINDOW_MS = 5 * 60 * 1000;
  const now = Date.now();

  // Purge events outside the 5-minute window
  metrics._recent_errors = metrics._recent_errors.filter(t => now - t < WINDOW_MS);
  metrics._recent_requests = metrics._recent_requests.filter(t => now - t < WINDOW_MS);

  const errorCount = metrics._recent_errors.length;
  const requestCount = metrics._recent_requests.length;

  const alertCriticalError = getAlertCriticalError();

  if (requestCount > 0) {
    const errorRate = (errorCount / requestCount) * 100;
    if (errorRate > 10) {
      const msg = `CRITICAL: error_rate=${errorRate.toFixed(1)}% in last 5 min (${errorCount}/${requestCount} requests)`;
      logger.error(`[metrics] ${msg}`);
      if (alertCriticalError) alertCriticalError(new Error(msg), 'metrics.checkThresholds');
    }
  }

  // ML pipeline threshold checks
  const featurePersistFailures = metrics['feature_persist_failures'] || 0;
  if (featurePersistFailures > 10) {
    const msg = `CRITICAL: feature_persist_failures=${featurePersistFailures} in last 5 min — ML feature pipeline degraded`;
    logger.error(`[metrics] ${msg}`);
    if (alertCriticalError) alertCriticalError(new Error(msg), 'metrics.checkThresholds');
  }

  const groundingViolations = metrics['brain_grounding_violations'] || 0;
  if (groundingViolations > 5) {
    logger.warn(`[metrics] WARNING: High grounding violation rate — brain_grounding_violations=${groundingViolations} in last 5 min`);
  }

  // Stale features check
  const staleCount = metrics['features_stale_count'] || 0;
  if (staleCount > 0) {
    logger.warn(`[metrics] WARNING: Stale features detected — ${staleCount} active leads have features older than 7 days`);
  }

  // Brain decision latency threshold
  const latestBrainLatency = metrics['_latest_brain_decision_time_ms'];
  if (latestBrainLatency != null && latestBrainLatency > 30000) {
    const msg = `CRITICAL: Brain decision latency > 30s (${latestBrainLatency}ms)`;
    logger.error(`[metrics] ${msg}`);
    if (alertCriticalError) alertCriticalError(new Error(msg), 'metrics.checkThresholds');
  }

  // Job queue depth check (requires DB)
  if (_db) {
    try {
      _db.query(
        "SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'", [], 'get'
      ).then(queueDepth => {
        if (queueDepth && queueDepth.c > 100) {
          logger.warn(`[metrics] WARNING: job queue depth=${queueDepth.c} — exceeds 100 pending jobs`);
        }
      }).catch(() => {});
    } catch (_) {
      // job_queue table may not exist in all environments — skip silently
    }
  }
}

/**
 * Record a metric value
 * @param {string} name - Metric name
 * @param {number} [value=1] - Value to add/set
 * @param {string} [type='counter'] - 'counter' (increment) or 'gauge' (set)
 */
function recordMetric(name, value = 1, type = 'counter') {
  if (type === 'counter') {
    metrics[name] = (metrics[name] || 0) + value;
    // Track recent errors and requests for threshold alerting
    if (name === 'total_errors') {
      metrics._recent_errors.push(Date.now());
      _recordSlidingRequest(true);
    }
    if (name === 'total_requests') {
      metrics._recent_requests.push(Date.now());
      _recordSlidingRequest(false);
    }
    // Also track total_calls as non-error requests in the sliding window
    if (name === 'total_calls') {
      _recordSlidingRequest(false);
    }
  } else if (type === 'gauge') {
    metrics[name] = value;
  } else if (type === 'histogram') {
    // Track latest value for threshold alerting
    metrics[`_latest_${name}`] = value;
    // For histograms, track in named sample arrays
    const key = `_hist_${name}`;
    if (!metrics[key]) metrics[key] = [];
    metrics[key].push(value);
    // Keep only last 1000 samples
    if (metrics[key].length > 1000) {
      metrics[key] = metrics[key].slice(-1000);
    }
    // Update average
    const sum = metrics[key].reduce((a, b) => a + b, 0);
    metrics[`avg_${name}`] = Math.round(sum / metrics[key].length);
    // Backward compat: response_time_ms also updates legacy fields
    if (name === 'response_time_ms') {
      metrics._response_times = metrics[key];
      metrics.avg_response_time_ms = metrics[`avg_${name}`];
    }
  }
}

/**
 * Get all metrics as JSON
 * @returns {object} Current metrics snapshot
 */
function getMetrics() {
  const uptime = Math.floor((Date.now() - metrics._last_reset.getTime()) / 1000);

  return {
    timestamp: new Date().toISOString(),
    uptime_seconds: uptime,
    total_calls: metrics.total_calls,
    total_sms_sent: metrics.total_sms_sent,
    total_sms_failed: metrics.total_sms_failed,
    total_brain_decisions: metrics.total_brain_decisions,
    total_errors: metrics.total_errors,
    active_clients: metrics.active_clients,
    avg_response_time_ms: metrics.avg_response_time_ms,
    sms_success_rate: metrics.total_sms_sent > 0
      ? Math.round((metrics.total_sms_sent / (metrics.total_sms_sent + metrics.total_sms_failed)) * 100)
      : 0,
  };
}

/**
 * Reset all metrics
 */
function resetMetrics() {
  metrics.total_calls = 0;
  metrics.total_sms_sent = 0;
  metrics.total_sms_failed = 0;
  metrics.total_brain_decisions = 0;
  metrics.total_errors = 0;
  metrics.active_clients = 0;
  metrics.avg_response_time_ms = 0;
  metrics._response_times = [];
  metrics._recent_errors = [];
  metrics._recent_requests = [];
  metrics._last_reset = new Date();
  // Reset all histogram sample arrays and their computed averages
  for (const key of Object.keys(metrics)) {
    if (key.startsWith('_hist_')) {
      metrics[key] = [];
    } else if (key.startsWith('avg_') && key !== 'avg_response_time_ms') {
      metrics[key] = 0;
    } else if (key.startsWith('_latest_')) {
      delete metrics[key];
    }
  }
  // Reset sliding window ring buffer
  _ringBuffer.length = 0;
  _ringHead = 0;
  _ringFull = false;
  logger.info('[metrics] Metrics reset');
}

module.exports = { recordMetric, getMetrics, resetMetrics, initMetricsFlush, flushMetricsSnapshot, getSlidingErrorRate };
