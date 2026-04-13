const { logger } = require('../../utils/logger');
const { isLeadComplete } = require('../../utils/dbHelpers');
const { CircuitBreaker } = require('../../utils/resilience');
const { AppError } = require('../../utils/AppError');
const { SMS_MAX_LENGTH } = require('../../config/timing');

// Circuit breaker for Retell outbound call creation — opens after 3 failures in 60s.
// On open: falls back to sending an SMS instead of leaving the lead uncontacted.
const retellCallBreaker = new CircuitBreaker(
  async (url, opts) => {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts });
    if (!resp.ok) throw new AppError('UPSTREAM_ERROR', `Retell create-phone-call ${resp.status}`, 502);
    return resp;
  },
  {
    failureThreshold: 3,
    failureWindow: 60000,
    cooldownPeriod: 30000,
    serviceName: 'Retell-OutboundCall',
    fallback: () => ({ ok: false, fallback: true }),
  }
);

/**
 * Handler: speed_to_lead_sms
 * Sends the first SMS in a speed-to-lead sequence.
 */
async function speedToLeadSms(db, sendSMS, payload) {
  // Check if lead already booked/completed before sending
  if (payload.leadId) {
    const lead = await db.query('SELECT stage FROM leads WHERE id = ?', [payload.leadId], 'get');
    if (isLeadComplete(lead)) {
      logger.info(`[jobQueue] Skipping speed_to_lead_sms — lead ${payload.leadId} already ${lead.stage}`);
      return;
    }
  }
  // Check for recent duplicate SMS to prevent queue retry duplication
  const recentSMS = await db.query(
    "SELECT id FROM messages WHERE phone = ? AND created_at > ? AND direction = 'outbound'",
    [payload.phone, new Date(Date.now() - 5 * 60 * 1000).toISOString()], 'get'
  );
  if (recentSMS) {
    logger.info(`[jobHandlers] Skipping duplicate SMS to ${payload.phone}`);
    return;
  }
  // Truncate to SMS max for concatenated messages (Telnyx/Twilio compat)
  const message = (payload.message || '').slice(0, SMS_MAX_LENGTH);
  const result = await sendSMS(payload.phone, message, payload.from, db, payload.clientId);
  if (result && !result.success) {
    throw new Error(`speed_to_lead_sms failed: ${result.error || result.reason || 'unknown'}`);
  }
}

/**
 * Handler: speed_to_lead_callback
 * Triggers an outbound Retell call for a speed-to-lead sequence.
 */
async function speedToLeadCallback(db, sendSMS, captureException, payload) {
  const { RETELL_CALL_TIMEOUT_MS } = require('../../config/timing');

  const client = await db.query('SELECT * FROM clients WHERE id = ?', [payload.clientId], 'get');
  if (!client) {
    logger.error(`[jobQueue] speed_to_lead_callback — client ${payload.clientId} not found`);
    return;
  }
  // Check if lead already booked before making the callback
  const lead = await db.query('SELECT stage FROM leads WHERE id = ?', [payload.leadId], 'get');
  if (isLeadComplete(lead)) {
    logger.info(`[jobQueue] Skipping callback — lead ${payload.leadId} already ${lead.stage}`);
    return;
  }
  // Check if AI is active
  if (!client.is_active) {
    logger.info(`[jobQueue] Skipping callback — AI paused for client ${payload.clientId}`);
    return;
  }
  // Check for recent duplicate call to prevent queue retry duplication
  const recentCall = await db.query(
    "SELECT id FROM calls WHERE phone = ? AND created_at > ?",
    [payload.phone, new Date(Date.now() - 5 * 60 * 1000).toISOString()], 'get'
  );
  if (recentCall) {
    logger.info(`[jobHandlers] Skipping duplicate call to ${payload.phone}`);
    return;
  }
  // Actually make the Retell outbound call
  const agentId = payload.retell_agent_id || client.retell_agent_id;
  const fromPhone = payload.retell_phone || client.phone_number || client.retell_phone;
  if (!agentId || !fromPhone || !payload.phone) {
    logger.warn(`[jobQueue] speed_to_lead_callback — missing agent_id (${agentId}), from (${fromPhone}), or to (${payload.phone})`);
    // Fallback: send SMS instead
    const smsMsg = `Hi${payload.name ? ' ' + payload.name.split(' ')[0] : ''}! We tried calling you from ${client.business_name || 'us'}. ${client.calcom_booking_link ? 'Book at: ' + client.calcom_booking_link : 'Call us back when you can!'}`.slice(0, SMS_MAX_LENGTH);
    const fallbackPhone = client.phone_number;
    await sendSMS(payload.phone, smsMsg, fallbackPhone, db, client.id);
    return;
  }
  const RETELL_API_KEY = process.env.RETELL_API_KEY;
  if (!RETELL_API_KEY) {
    logger.warn('[jobQueue] No RETELL_API_KEY — cannot make outbound call');
    return;
  }
  try {
    const resp = await retellCallBreaker.call('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from_number: fromPhone,
        to_number: payload.phone,
        agent_id: agentId,
        metadata: {
          lead_id: payload.leadId,
          client_id: payload.clientId,
          reason: payload.reason || 'speed_callback',
          transfer_number: client.transfer_phone || client.owner_phone || '',
        },
      }),
    });
    if (resp.fallback) {
      logger.warn('[jobQueue] Retell circuit open — falling back to SMS for speed callback');
      const fallbackMsg = `Hi${payload.name ? ' ' + payload.name.split(' ')[0] : ''}! We tried to reach you from ${client.business_name || 'us'}. ${client.calcom_booking_link ? 'Book at: ' + client.calcom_booking_link : 'Call us back!'}`.slice(0, SMS_MAX_LENGTH);
      const fallbackPhone = client.phone_number;
      await sendSMS(payload.phone, fallbackMsg, fallbackPhone, db, client.id);
    } else {
      const data = await resp.json();
      logger.info(`[jobQueue] Retell outbound call created: ${data.call_id || 'ok'} to ${payload.phone}`);
    }
  } catch (callErr) {
    logger.error(`[jobQueue] Retell outbound call error:`, callErr.message);
    if (captureException) {
      captureException(callErr, { context: 'speed_to_lead_callback', leadId: payload.leadId });
    }
    // Fallback SMS on any unexpected error
    try {
      const fallbackMsg = `Hi${payload.name ? ' ' + payload.name.split(' ')[0] : ''}! We tried to reach you from ${client.business_name || 'us'}. ${client.calcom_booking_link ? 'Book at: ' + client.calcom_booking_link : 'Call us back!'}`.slice(0, SMS_MAX_LENGTH);
      const fallbackPhone = client.phone_number;
      await sendSMS(payload.phone, fallbackMsg, fallbackPhone, db, client.id);
    } catch (_) {}
  }
}

module.exports = { speedToLeadSms, speedToLeadCallback };
