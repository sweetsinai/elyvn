/**
 * Monitoring & Health Metrics
 * Lightweight in-memory metrics collector
 */

const { logger } = require('./logger');

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
};

/**
 * Record a metric value
 * @param {string} name - Metric name
 * @param {number} [value=1] - Value to add/set
 * @param {string} [type='counter'] - 'counter' (increment) or 'gauge' (set)
 */
function recordMetric(name, value = 1, type = 'counter') {
  if (type === 'counter') {
    metrics[name] = (metrics[name] || 0) + value;
  } else if (type === 'gauge') {
    metrics[name] = value;
  } else if (type === 'histogram') {
    // For histograms, track response times
    if (name === 'response_time_ms') {
      metrics._response_times.push(value);
      // Keep only last 1000 samples
      if (metrics._response_times.length > 1000) {
        metrics._response_times = metrics._response_times.slice(-1000);
      }
      // Update average
      const sum = metrics._response_times.reduce((a, b) => a + b, 0);
      metrics.avg_response_time_ms = Math.round(sum / metrics._response_times.length);
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
  metrics._last_reset = new Date();
  logger.info('[metrics] Metrics reset');
}

module.exports = { recordMetric, getMetrics, resetMetrics };
