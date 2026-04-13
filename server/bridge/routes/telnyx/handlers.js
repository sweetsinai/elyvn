/**
 * SMS keyword and dispatch handlers:
 * handleInboundSMS, handleOptOut, handleOptIn, handleCancel, handleYes.
 */

const { randomUUID } = require('crypto');

const { hasNonce, addNonce } = require('../../utils/nonceStore');
const { sendSMS } = require('../../utils/sms');
const { cancelBooking } = require('../../utils/calcom');
const { logger } = require('../../utils/logger');
const { encrypt } = require('../../utils/encryption');
const { appendEvent, Events } = require('../../utils/eventStore');
const { handleNormalMessage } = require('./normalMessage');
const { SMS_MAX_LENGTH } = require('../../config/timing');

async function handleInboundSMS(db, { from, to, body, messageId }) {
  try {
    logger.info(`[telnyx] SMS from ${from ? from.replace(/\d(?=\d{4})/g, '*') : '?'} to ${to} (${(body || '').length} chars)`);

    // Fast nonce check (Redis or in-memory) before hitting the DB
    if (messageId && await hasNonce(messageId)) {
      logger.warn(`[telnyx] Duplicate webhook rejected: ${messageId}`);
      return;
    }
    if (messageId) {
      await addNonce(messageId, 3600); // 1 hour TTL
    }

    // Idempotency: skip if this messageId was already processed (webhook retry)
    if (messageId) {
      const dup = await db.query('SELECT id FROM messages WHERE message_sid = ?', [messageId], 'get');
      if (dup) {
        logger.info(`[telnyx] Duplicate messageId ${messageId}, skipping`);
        return;
      }
    }

    // Identify client by matching To number
    // Unified phone lookup — single number for calls + SMS
    const client = await db.query(
      'SELECT * FROM clients WHERE phone_number = ?',
      [to],
      'get'
    );

    if (!client) {
      logger.error(`[telnyx] No client found for number ${to}`);
      return;
    }

    const trimmed = (body || '').toUpperCase().trim();

    if (/^(STOP|UNSUBSCRIBE|QUIT|END)$/.test(trimmed)) {
      await handleOptOut(db, client, from, to, trimmed);
    } else if (/^(START|SUBSCRIBE|YES)$/.test(trimmed) && trimmed !== 'YES') {
      // Handle re-opt-in (but not YES which is for booking)
      await handleOptIn(db, client, from, to);
    } else if (trimmed === 'CANCEL') {
      await handleCancel(db, client, from, to);
    } else if (trimmed === 'YES') {
      await handleYes(db, client, from, to);
    } else {
      await handleNormalMessage(db, client, from, to, body, messageId);
    }
  } catch (err) {
    logger.error('[telnyx] handleInboundSMS error:', err);
  }
}

async function handleOptOut(db, client, from, to, keyword) {
  try {
    const { recordOptOut } = require('../../utils/optOut');
    recordOptOut(db, from, client.id, keyword);

    const msg = `You've been unsubscribed from ${client.business_name || 'our'} messages. Reply START to resubscribe.`;
    await sendSMS(from, msg.slice(0, SMS_MAX_LENGTH), to, db, client.id);

    logger.info(`[telnyx] Recorded opt-out for ${from} (${keyword})`);
  } catch (err) {
    logger.error('[telnyx] handleOptOut error:', err);
  }
}

async function handleOptIn(db, client, from, to) {
  try {
    const { recordOptIn } = require('../../utils/optOut');
    recordOptIn(db, from, client.id);

    const msg = `Welcome back! You're now subscribed to ${client.business_name || 'our'} messages.`;
    await sendSMS(from, msg.slice(0, SMS_MAX_LENGTH), to, db, client.id);

    logger.info(`[telnyx] Recorded opt-in for ${from}`);
  } catch (err) {
    logger.error('[telnyx] handleOptIn error:', err);
  }
}

async function handleCancel(db, client, from, replyFrom) {
  try {
    const lead = await db.query(
      'SELECT calcom_booking_id FROM leads WHERE phone = ? AND client_id = ? AND calcom_booking_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
      [from, client.id],
      'get'
    );

    if (!lead?.calcom_booking_id) {
      await sendSMS(from, 'No upcoming appointment found to cancel.', replyFrom, db, client.id);
      return;
    }

    const result = await cancelBooking(lead.calcom_booking_id);

    if (result.success) {
      await db.query(
        'UPDATE leads SET calcom_booking_id = NULL, stage = \'contacted\', updated_at = ? WHERE phone = ? AND client_id = ?',
        [new Date().toISOString(), from, client.id],
        'run'
      );
      await sendSMS(from, 'Your appointment has been cancelled.', replyFrom, db, client.id);
      logger.info(`[telnyx] Booking ${lead.calcom_booking_id} cancelled for ${from}`);
    } else {
      await sendSMS(from, 'Sorry, we couldn\'t cancel your appointment right now. Please call us directly.', replyFrom, db, client.id);
    }
  } catch (err) {
    logger.error('[telnyx] handleCancel error:', err);
    await sendSMS(from, 'Sorry, something went wrong. Please call us directly.', replyFrom, db, client.id).catch(e => logger.warn('[telnyx] Error SMS send failed', e.message));
  }
}

async function handleYes(db, client, from, replyFrom) {
  try {
    const bookingLink = client.calcom_booking_link;
    const msg = bookingLink
      ? `Book your appointment here: ${bookingLink}`
      : 'Please call us to schedule your appointment.';
    await sendSMS(from, msg.slice(0, SMS_MAX_LENGTH), replyFrom, db, client.id);
  } catch (err) {
    logger.error('[telnyx] handleYes error:', err);
  }
}

module.exports = { handleInboundSMS };
