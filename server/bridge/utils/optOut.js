/**
 * SMS Opt-Out / TCPA Compliance
 * Tracks opt-outs by phone number and prevents SMS to opted-out numbers
 */

/**
 * Check if a phone number has opted out from SMS
 * @param {object} db - better-sqlite3 instance
 * @param {string} phone - Phone number
 * @param {string} clientId - Client ID
 * @returns {boolean} True if opted out
 */
function isOptedOut(db, phone, clientId) {
  if (!db || !phone) return false;

  try {
    const result = db.prepare(
      'SELECT id FROM sms_opt_outs WHERE phone = ? AND client_id = ? AND opted_out_at IS NOT NULL'
    ).get(phone, clientId);

    return !!result;
  } catch (err) {
    console.error('[optOut] isOptedOut error:', err.message);
    return false;
  }
}

/**
 * Record a phone number as opted out
 * @param {object} db - better-sqlite3 instance
 * @param {string} phone - Phone number
 * @param {string} clientId - Client ID
 * @param {string} [reason] - Reason for opt-out (STOP, UNSUBSCRIBE, etc)
 * @returns {boolean} Success
 */
function recordOptOut(db, phone, clientId, reason = 'user_request') {
  if (!db || !phone || !clientId) return false;

  try {
    const { randomUUID } = require('crypto');
    db.prepare(`
      INSERT OR REPLACE INTO sms_opt_outs (id, phone, client_id, opted_out_at, reason)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(randomUUID(), phone, clientId, reason);

    console.log(`[optOut] Recorded opt-out for ${phone} (${reason})`);
    return true;
  } catch (err) {
    console.error('[optOut] recordOptOut error:', err.message);
    return false;
  }
}

/**
 * Record a phone number as opted in (remove from opt-out list)
 * @param {object} db - better-sqlite3 instance
 * @param {string} phone - Phone number
 * @param {string} clientId - Client ID
 * @returns {boolean} Success
 */
function recordOptIn(db, phone, clientId) {
  if (!db || !phone || !clientId) return false;

  try {
    db.prepare(
      'DELETE FROM sms_opt_outs WHERE phone = ? AND client_id = ?'
    ).run(phone, clientId);

    console.log(`[optOut] Recorded opt-in for ${phone}`);
    return true;
  } catch (err) {
    console.error('[optOut] recordOptIn error:', err.message);
    return false;
  }
}

module.exports = { isOptedOut, recordOptOut, recordOptIn };
