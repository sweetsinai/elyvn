/**
 * SMS Opt-Out / TCPA Compliance
 * Tracks opt-outs by phone number and prevents SMS to opted-out numbers
 */

const { logger } = require('./logger');

/**
 * Check if a phone number has opted out from SMS
 * @param {object} db - database instance
 * @param {string} phone - Phone number
 * @param {string} clientId - Client ID
 * @returns {Promise<boolean>} True if opted out
 */
async function isOptedOut(db, phone, clientId) {
  if (!db || !phone) return false;

  try {
    const result = await db.query(
      'SELECT id FROM sms_opt_outs WHERE phone = ? AND client_id = ? AND opted_out_at IS NOT NULL',
      [phone, clientId],
      'get'
    );

    return !!result;
  } catch (err) {
    logger.error('[optOut] isOptedOut error:', err.message);
    return false;
  }
}

/**
 * Record a phone number as opted out
 * @param {object} db - database instance
 * @param {string} phone - Phone number
 * @param {string} clientId - Client ID
 * @param {string} [reason] - Reason for opt-out (STOP, UNSUBSCRIBE, etc)
 * @returns {Promise<boolean>} Success
 */
async function recordOptOut(db, phone, clientId, reason = 'user_request') {
  if (!db || !phone || !clientId) return false;

  try {
    const { randomUUID } = require('crypto');
    await db.query(`
      INSERT OR REPLACE INTO sms_opt_outs (id, phone, client_id, opted_out_at, reason)
      VALUES (?, ?, ?, datetime('now'), ?)
    `, [randomUUID(), phone, clientId, reason], 'run');

    logger.info(`[optOut] Recorded opt-out for ${phone} (${reason})`);

    // Emit OptOutRecorded event for audit trail
    try {
      const { appendEvent, Events } = require('./eventStore');
      // Look up the lead ID for this phone + client
      const lead = await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ? LIMIT 1', [phone, clientId], 'get');
      if (lead) {
        await appendEvent(db, lead.id, 'lead', Events.OptOutRecorded, { phone, reason }, clientId);
      }
    } catch (_) {
      // Event logging failure is non-fatal
    }

    return true;
  } catch (err) {
    logger.error('[optOut] recordOptOut error:', err.message);
    return false;
  }
}

/**
 * Record a phone number as opted in (remove from opt-out list)
 * @param {object} db - database instance
 * @param {string} phone - Phone number
 * @param {string} clientId - Client ID
 * @returns {Promise<boolean>} Success
 */
async function recordOptIn(db, phone, clientId) {
  if (!db || !phone || !clientId) return false;

  try {
    await db.query(
      'DELETE FROM sms_opt_outs WHERE phone = ? AND client_id = ?',
      [phone, clientId],
      'run'
    );

    logger.info(`[optOut] Recorded opt-in for ${phone}`);
    return true;
  } catch (err) {
    logger.error('[optOut] recordOptIn error:', err.message);
    return false;
  }
}

module.exports = { isOptedOut, recordOptOut, recordOptIn };
