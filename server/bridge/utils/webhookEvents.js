/**
 * Outbound Webhook Event Helpers
 *
 * Centralized functions for firing webhook events to client-configured URLs.
 * Each event type checks whether the client has a URL configured for that event,
 * then enqueues a delivery via webhookQueue.js.
 *
 * Event schema: { event, clientId, timestamp, data }
 */

const { enqueue } = require('./webhookQueue');
const { logger } = require('./logger');

/**
 * Build standardized webhook payload.
 */
function buildPayload(event, clientId, data) {
  return {
    event,
    clientId,
    timestamp: new Date().toISOString(),
    data,
  };
}

/**
 * Fire a call_ended webhook if the client has a call_webhook_url configured.
 */
async function fireCallEnded(client, { callId, phone, duration, outcome, score, summary, sentiment }) {
  if (!client.call_webhook_url) return;
  try {
    await enqueue(
      client.call_webhook_url,
      buildPayload('call_ended', client.id, { callId, phone, duration, outcome, score, summary, sentiment }),
      { 'X-Client-Id': client.id }
    );
  } catch (err) {
    logger.error('[webhookEvents] fireCallEnded error:', err.message);
  }
}

/**
 * Fire a lead.stage_changed webhook if the client has a stage_change_webhook_url configured.
 */
async function fireLeadStageChanged(client, { leadId, oldStage, newStage, leadData }) {
  if (!client.stage_change_webhook_url) return;
  try {
    await enqueue(
      client.stage_change_webhook_url,
      buildPayload('lead.stage_changed', client.id, { leadId, oldStage, newStage, ...leadData }),
      { 'X-Client-Id': client.id }
    );
  } catch (err) {
    logger.error('[webhookEvents] fireLeadStageChanged error:', err.message);
  }
}

/**
 * Fire an sms.received webhook if the client has an sms_webhook_url configured.
 */
async function fireSmsReceived(client, { from, to, body, messageId, leadId }) {
  if (!client.sms_webhook_url) return;
  try {
    await enqueue(
      client.sms_webhook_url,
      buildPayload('sms.received', client.id, { from, to, body, messageId, leadId }),
      { 'X-Client-Id': client.id }
    );
  } catch (err) {
    logger.error('[webhookEvents] fireSmsReceived error:', err.message);
  }
}

/**
 * Fire an sms.sent webhook if the client has an sms_webhook_url configured.
 */
async function fireSmsSent(client, { to, from, body, messageId, leadId }) {
  if (!client.sms_webhook_url) return;
  try {
    await enqueue(
      client.sms_webhook_url,
      buildPayload('sms.sent', client.id, { to, from, body, messageId, leadId }),
      { 'X-Client-Id': client.id }
    );
  } catch (err) {
    logger.error('[webhookEvents] fireSmsSent error:', err.message);
  }
}

module.exports = { fireCallEnded, fireLeadStageChanged, fireSmsReceived, fireSmsSent, buildPayload };
