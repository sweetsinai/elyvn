const https = require('https');

// === Provider config (auto-detect: Twilio first, then Telnyx) ===
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_PHONE = process.env.TELNYX_PHONE_NUMBER;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;

// Determine active provider
const SMS_PROVIDER = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) ? 'twilio'
  : TELNYX_API_KEY ? 'telnyx'
  : null;

const DEFAULT_FROM = SMS_PROVIDER === 'twilio' ? TWILIO_PHONE : TELNYX_PHONE;

if (SMS_PROVIDER) {
  console.log(`[sms] Using ${SMS_PROVIDER} as SMS provider (from: ${DEFAULT_FROM || 'not set'})`);
} else {
  console.warn('[sms] No SMS provider configured — set TWILIO or TELNYX env vars');
}

const { SMS_MIN_GAP_MS, SMS_RATE_LIMIT_CLEANUP_MS, SMS_MAX_RATE_LIMIT_ENTRIES, DUPLICATE_SMS_LOOKBACK_MS } = require('../config/timing');

/**
 * Make an HTTPS request and return {status, body}
 */
function httpsRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (err) {
          // Return raw body if JSON parse fails
          resolve({ status: res.statusCode, body, parseError: err });
        }
      });
    });

    req.on('error', reject);
    if (data) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      req.write(payload);
    }
    req.end();
  });
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
 * Send SMS via Twilio REST API (no SDK needed)
 */
async function sendViaTwilio(to, body, from) {
  const formData = new URLSearchParams({
    To: to,
    From: from,
    Body: body,
  }).toString();

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const options = {
    hostname: 'api.twilio.com',
    port: 443,
    path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formData),
    },
  };

  const response = await httpsRequest(options, formData);

  if (response.status !== 201 && response.status !== 200) {
    const errorMsg = response.body?.message || response.body?.error_message || JSON.stringify(response.body);
    throw new Error(`Twilio API error (${response.status}): ${errorMsg}`);
  }

  return response.body?.sid || response.body?.message_sid;
}

/**
 * Send SMS via Telnyx REST API
 */
async function sendViaTelnyx(to, body, from) {
  const payload = {
    from: from,
    to: to,
    text: body,
  };

  if (TELNYX_MESSAGING_PROFILE_ID) {
    payload.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
  }

  const options = {
    hostname: 'api.telnyx.com',
    port: 443,
    path: '/v2/messages',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  const response = await httpsRequest(options, payload);

  if (response.status !== 200 && response.status !== 201) {
    const errorMsg = response.body?.errors?.[0]?.detail || response.body || 'Unknown error';
    throw new Error(`Telnyx API error (${response.status}): ${errorMsg}`);
  }

  return response.body?.data?.id;
}

/**
 * Send SMS via the configured provider (Twilio or Telnyx) with retry logic.
 * @param {string} to - Recipient phone number
 * @param {string} body - Message body
 * @param {string} [from] - Sender phone number (defaults to provider default)
 * @param {object} [db] - better-sqlite3 instance for opt-out checking
 * @param {string} [clientId] - Client ID for opt-out checking
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendSMS(to, body, from, db, clientId) {
  const fromNumber = from || DEFAULT_FROM;

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
    }
  }

  if (!SMS_PROVIDER) {
    console.error('[sms] No SMS provider configured');
    return { success: false, error: 'SMS not configured' };
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
    let messageId;

    if (SMS_PROVIDER === 'twilio') {
      messageId = await sendViaTwilio(to, bodyWithFooter, fromNumber);
    } else {
      messageId = await sendViaTelnyx(to, bodyWithFooter, fromNumber);
    }

    lastSendTime.set(to, Date.now());
    console.log(`[sms] [${SMS_PROVIDER}] Sent to ${to}: ${messageId}`);

    // Record metrics
    try {
      const { recordMetric } = require('./metrics');
      recordMetric('total_sms_sent', 1, 'counter');
    } catch (_) {}

    return { success: true, messageId };
  } catch (err) {
    console.error(`[sms] [${SMS_PROVIDER}] Failed to send to ${to}:`, err.message);

    // Record failed metric
    try {
      const { recordMetric } = require('./metrics');
      recordMetric('total_sms_failed', 1, 'counter');
    } catch (_) {}

    // Only schedule retry for transient errors (not auth/config failures)
    const NON_RETRYABLE = ['Authentication', 'Invalid API Key', 'not configured', 'suspended', 'balance', 'Authenticate', 'blacklist'];
    const isRetryable = !NON_RETRYABLE.some(msg => err.message.includes(msg));
    if (isRetryable && db) {
      try {
        const { enqueueJob } = require('./jobQueue');
        const retryTime = new Date(Date.now() + MIN_GAP_MS).toISOString();
        enqueueJob(db, 'followup_sms', { to, message: body, from: fromNumber, clientId }, retryTime);
      } catch (_) {
        // Silently fail if job queue not available
      }
    } else if (!isRetryable) {
      console.error(`[sms] Non-retryable error for ${to}: ${err.message} — will not retry`);
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
    const client = db.prepare('SELECT owner_phone, telnyx_phone, twilio_phone FROM clients WHERE id = ?').get(clientId);

    if (!client?.owner_phone) {
      console.error(`[sms] No owner_phone for client ${clientId}`);
      return { success: false, error: 'No owner phone number' };
    }

    // Use whichever phone the client has configured
    const fromPhone = client.telnyx_phone || client.twilio_phone;
    return sendSMS(client.owner_phone, body, fromPhone);
  } catch (err) {
    console.error('[sms] sendSMSToOwner error:', err);
    return { success: false, error: err.message };
  }
}

function cleanupSMSTimers() {
  if (smsRateLimitCleanupInterval) clearInterval(smsRateLimitCleanupInterval);
}

module.exports = { sendSMS, sendSMSToOwner, cleanupSMSTimers, SMS_PROVIDER };
