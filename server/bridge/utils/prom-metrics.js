'use strict';
/**
 * Prometheus Metrics
 * Production-grade prom-client instrumentation for ELYVN bridge server.
 * Exposes default Node.js metrics plus business-level counters/histograms.
 */
const client = require('prom-client');

// Isolated registry so we don't collide with any third-party default metrics
const register = new client.Registry();

// Default metrics: CPU, memory, event loop lag, active handles/requests, GC
client.collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// HTTP request duration — labelled by method, route, and status code
// ---------------------------------------------------------------------------
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Webhook processing — retell | twilio | calcom, success | error
// ---------------------------------------------------------------------------
const webhookProcessed = new client.Counter({
  name: 'webhook_processed_total',
  help: 'Total webhooks processed',
  labelNames: ['source', 'status'], // source: retell|twilio|calcom, status: success|error
  registers: [register],
});

// ---------------------------------------------------------------------------
// Background job processing
// ---------------------------------------------------------------------------
const jobsProcessed = new client.Counter({
  name: 'jobs_processed_total',
  help: 'Total background jobs processed',
  labelNames: ['type', 'status'], // status: success|error
  registers: [register],
});

// ---------------------------------------------------------------------------
// Active leads gauge — refreshed periodically by the job queue cycle
// ---------------------------------------------------------------------------
const activeLeads = new client.Gauge({
  name: 'active_leads_total',
  help: 'Number of active leads in pipeline',
  labelNames: ['client_id'],
  registers: [register],
});

// ---------------------------------------------------------------------------
// SMS delivery counters
// ---------------------------------------------------------------------------
const smsDelivered = new client.Counter({
  name: 'sms_delivered_total',
  help: 'SMS messages delivered',
  labelNames: ['status'], // success|failed
  registers: [register],
});

// ---------------------------------------------------------------------------
// Retell voice call counters
// ---------------------------------------------------------------------------
const callsTotal = new client.Counter({
  name: 'retell_calls_total',
  help: 'Total Retell AI voice calls',
  labelNames: ['event', 'direction'], // event: call_started|call_ended|call_analyzed, direction: inbound|outbound
  registers: [register],
});

// ---------------------------------------------------------------------------
// Email outreach counters
// ---------------------------------------------------------------------------
const emailsTotal = new client.Counter({
  name: 'emails_total',
  help: 'Total emails sent via outreach pipeline',
  labelNames: ['status'], // success|failed
  registers: [register],
});

module.exports = {
  register,
  httpRequestDuration,
  webhookProcessed,
  jobsProcessed,
  activeLeads,
  smsDelivered,
  callsTotal,
  emailsTotal,
};
