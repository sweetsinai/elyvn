const twilio = require('twilio');

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

const { SMS_MIN_GAP_MS, SMS_RATE_LIMIT_CLEANUP_MS, SMS_MAX_RATE_LIMIT_ENTRIES, DUPLICATE_SMS_LOOKBACK_MS } = require('../config/timing');
let client = null;
function getClient() {
  if (!client && TWILIO_SID && TWILIO_TOKEN) {
    client = twilio(TWILIO_SID, TWILIO_TOKEN);
  }
  return client;
}

// Rate limiter: track last send time per phone number (capped to prevent memory leaks)
const lastSendTime = new Map();
const MIN_GAP_MS = SMS_MIN_GAP_MS; // 5 minutes
const MAX_RATE_LIMIT_ENTRIES = SMS_MAX_RATE_LIMIT_ENTRIES;

// Periodic cleanup of stale rate limit entries
const smsRateLimitCleanupInterval = setInterval(() => {
  const cutoff = Date.now() - MIN_GAP_MS;
  for (const [phone, time] of lastSendTime) {
    if (time < cutoff) lastSendTime.delete(phone);
  }
  if (lastSendTime.size > MAX_RATE_LIMIT_ENTRIES) {
    console.warn(`[sms] Rate limit map too large (${lastSendTime.size}), clearing`);
    lastSendTime.clear();
  }
}, SMS_RATE_LIMIT_CLEANUP_MS); // Every 10 minutes

/**
 * Send SMS via Twilio REST API with retry logic.
 * @param {string} to - Recipient phone number
 * @param {string} body - Message body
 * @param {string} [from] - Sender phone number (defaults to TWILIO_PHONE_NUMBER)
 * @param {object} [db] - better-sqlite3 instance for opt-out checking
 * @param {string} [clientId] - Client ID for opt-out checking
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendSMS(to, body, from, db, clientId) {
  const fromNumber = from || TWILIO_PHONE;

  if (!fromNumber) {
    console.error('[sms] No from number configured');
    return { success: false, error: 'No from number configured' };
  }

  // Check opt-out (if db and clientId provided)
  if (db && clientId) {
    try {
      const { isOptedOut } = require('./optOut');
      if (isOptedOut(db, to, clientId)) {
        console.log(`[sms] Number ${to} is opted out — skipping send`);
        return { success: false, reason: 'opted_out' };
      }
    } catch (err) {
      console.warn('[sms] Opt-out check error:', err.message);
      // Continue with send if opt-out check fails
    }
  }

  const twilioClient = getClient();
  if (!twilioClient) {
    console.error('[sms] Twilio client not initialized — check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    return { success: false, error: 'Twilio not configured' };
  }

  // Rate limit check
  const lastSent = lastSendTime.get(to);
  if (lastSent && Date.now() - lastSent < MIN_GAP_MS) {
    const waitSec = Math.ceil((MIN_GAP_MS - (Date.now() - lastSent)) / 1000);
    console.log(`[sms] Rate limited: ${to} (wait ${waitSec}s)`);
    return { success: false, error: `Rate limited. Retry in ${waitSec}s` };
  }

  // Add TCPA compliance footer if not already present
  let bodyWithFooter = body;
  if (!body.toUpperCase().includes('REPLY STOP') && body.length < 155) {
    bodyWithFooter = body + ' Reply STOP to opt out.';
  }

  try {
    const message = await twilioClient.messages.create({
      to,
      from: fromNumber,
      body: bodyWithFooter
    });

    lastSendTime.set(to, Date.now());
    console.log(`[sms] Sent to ${to}: ${message.sid}`);

    // Record metrics
    try {
      const { recordMetric } = require('./metrics');
      recordMetric('total_sms_sent', 1, 'counter');
    } catch (_) {}

    return { success: true, messageId: message.sid };
  } catch (err) {
    console.error(`[sms] Failed to send to ${to}:`, err.message);

    // Record failed metric
    try {
      const { recordMetric } = require('./metrics');
      recordMetric('total_sms_failed', 1, 'counter');
    } catch (_) {}

    // Schedule retry after 5 minutes (via job queue if available)
    try {
      if (db) {
        const { enqueueJob } = require('./jobQueue');
        const retryTime = new Date(Date.now() + MIN_GAP_MS).toISOString();
        enqueueJob(db, 'followup_sms', { to, message: body, from: fromNumber }, retryTime);
      }
    } catch (_) {
      // Fallback to setTimeout if job queue not available
      setTimeout(async () => {
        try {
          console.log(`[sms] Retrying send to ${to}...`);
          const retryMsg = await twilioClient.messages.create({
            to,
            from: fromNumber,
            body: bodyWithFooter
          });
          lastSendTime.set(to, Date.now());
          console.log(`[sms] Retry succeeded: ${to} ${retryMsg.sid}`);
        } catch (retryErr) {
          console.error(`[sms] Retry failed for ${to}:`, retryErr.message);
        }
      }, MIN_GAP_MS);
    }

    return { success: false, error: err.message };
  }
}

/**
 * Send SMS to a client's owner_phone.
 * Looks up the client by ID and sends to their owner_phone.
 * @param {object} db - better-sqlite3 database instance
 * @param {string} clientId - Client ID
 * @param {string} body - Message body
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendSMSToOwner(db, clientId, body) {
  try {
    const client = db.prepare('SELECT owner_phone, twilio_phone FROM clients WHERE id = ?').get(clientId);

    if (!client?.owner_phone) {
      console.error(`[sms] No owner_phone for client ${clientId}`);
      return { success: false, error: 'No owner phone number' };
    }

    return sendSMS(client.owner_phone, body, client.twilio_phone);
  } catch (err) {
    console.error('[sms] sendSMSToOwner error:', err);
    return { success: false, error: err.message };
  }
}

function cleanupSMSTimers() {
  if (smsRateLimitCleanupInterval) clearInterval(smsRateLimitCleanupInterval);
}

module.exports = { sendSMS, sendSMSToOwner, cleanupSMSTimers };
