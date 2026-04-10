'use strict';

/**
 * callTransfer.js — Call transfer utilities (warm via Retell, cold via Twilio)
 *
 * Phase 2: Warm transfer uses Retell API, cold transfer uses Twilio REST API
 * with inline TwiML. Fallback to voicemail + Telegram notification.
 */

const { CircuitBreaker } = require('./resilience');
const { logger } = require('./logger');
const { addTraceHeaders } = require('./tracing');

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_BASE = 'https://api.retellai.com/v2';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const { TRANSFER_DIAL_TIMEOUT_S, TRANSFER_VOICEMAIL_MAX_LENGTH_S } = require('../config/timing');

// Circuit breaker for Retell transfer API
const retellTransferBreaker = new CircuitBreaker(
  async (url, opts) => {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Retell transfer API ${resp.status}: ${body}`);
    }
    return resp;
  },
  {
    failureThreshold: 3,
    failureWindow: 60000,
    cooldownPeriod: 30000,
    serviceName: 'RetellTransfer',
    fallback: () => ({ ok: false, fallback: true }),
  }
);

/**
 * Warm transfer via Retell API — transfers the live call with an intro message.
 * Uses POST /v2/transfer-call/{call_id} (Retell handles SIP-level transfer).
 *
 * @param {string} callId - Retell call ID
 * @param {string} transferPhone - Phone number to transfer to
 * @param {string} [introMessage] - Message Retell speaks before connecting
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function warmTransfer(callId, transferPhone, introMessage) {
  if (!RETELL_API_KEY) {
    logger.warn('[transfer] No RETELL_API_KEY — warm transfer unavailable');
    return { success: false, error: 'RETELL_API_KEY not configured' };
  }

  try {
    const resp = await retellTransferBreaker.call(`${RETELL_BASE}/transfer-call/${callId}`, {
      method: 'POST',
      headers: addTraceHeaders({
        'Authorization': `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        transfer_to: transferPhone,
        ...(introMessage && { message: introMessage }),
      }),
    });

    if (resp.fallback) {
      return { success: false, error: 'Retell transfer service unavailable (circuit open)' };
    }

    const data = await resp.json().catch(() => ({}));
    logger.info(`[transfer] Warm transfer initiated: call=${callId} -> ${transferPhone}`);
    return { success: true, data };
  } catch (err) {
    logger.error(`[transfer] Warm transfer failed: call=${callId}`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Cold transfer via Twilio — updates the active Twilio call with inline TwiML
 * that dials the transfer_phone. If no answer within timeout, plays voicemail prompt.
 *
 * @param {string} twilioCallSid - Twilio Call SID
 * @param {string} transferPhone - Phone number to transfer to
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function coldTransfer(twilioCallSid, transferPhone) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    logger.warn('[transfer] Twilio not configured — cold transfer unavailable');
    return { success: false, error: 'Twilio not configured' };
  }

  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Dial timeout="${TRANSFER_DIAL_TIMEOUT_S}">`,
    `    <Number>${escapeXml(transferPhone)}</Number>`,
    '  </Dial>',
    '  <Say voice="Polly.Joanna">The person you are being transferred to is unavailable right now. Please leave a message after the tone.</Say>',
    `  <Record maxLength="${TRANSFER_VOICEMAIL_MAX_LENGTH_S}" playBeep="true" transcribe="true" />`,
    '  <Say voice="Polly.Joanna">Thank you. Goodbye.</Say>',
    '</Response>',
  ].join('\n');

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const formData = new URLSearchParams({ Twiml: twiml }).toString();

  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${twilioCallSid}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Twilio call update ${resp.status}: ${body}`);
    }

    const data = await resp.json().catch(() => ({}));
    logger.info(`[transfer] Cold transfer initiated: twilio_sid=${twilioCallSid} -> ${transferPhone}`);
    return { success: true, data };
  } catch (err) {
    logger.error(`[transfer] Cold transfer failed: twilio_sid=${twilioCallSid}`, err.message);
    return { success: false, error: err.message };
  }
}

/** Escape special XML characters in phone numbers (safety) */
function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  warmTransfer,
  coldTransfer,
  _retellTransferBreaker: retellTransferBreaker,
};
