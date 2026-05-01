/**
 * Usage Tracker — records per-client monthly usage for billing/metering.
 * Fire-and-forget: failures are logged but never block the main flow.
 */
const { randomUUID } = require('crypto');
const { logger } = require('./logger');

const QUERIES = {
  call:         'INSERT INTO usage_records (id, client_id, month, calls_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET calls_count = calls_count + 1',
  sms:          'INSERT INTO usage_records (id, client_id, month, sms_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET sms_count = sms_count + 1',
  ai_decision:  'INSERT INTO usage_records (id, client_id, month, ai_decisions_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET ai_decisions_count = ai_decisions_count + 1',
  email:        'INSERT INTO usage_records (id, client_id, month, emails_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET emails_count = emails_count + 1',
};

/**
 * Record a usage event for a client. Fire-and-forget.
 * @param {object} db
 * @param {string} clientId
 * @param {'call'|'sms'|'ai_decision'|'email'} type
 */
function trackUsage(db, clientId, type) {
  if (!db || !clientId || !QUERIES[type]) return;
  const month = new Date().toISOString().slice(0, 7);
  try {
    db.query(QUERIES[type], [randomUUID(), clientId, month], 'run').catch(err => {
      logger.warn(`[usageTracker] Failed to record ${type} for ${clientId}:`, err.message);
    });
  } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
}

module.exports = { trackUsage };
