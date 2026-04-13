const { logger } = require('../../utils/logger');
const { SMS_MAX_LENGTH } = require('../../config/timing');

/**
 * Handler: google_review_request
 *
 * Sends a Google Review request SMS to a lead after their appointment is completed.
 * Triggered 2h after appointment end time via calcom webhook or appointment status update.
 *
 * Payload:
 *   { phone, clientId, leadId, appointmentId, businessName, googleReviewLink, from }
 */
async function googleReviewRequest(payload, jobId, db) {
  try {
    const { phone, clientId, leadId, appointmentId, businessName, googleReviewLink, from } = payload;

    if (!phone || !clientId || !googleReviewLink) {
      logger.warn(`[reviewRequest] Missing required fields for job ${jobId}`);
      return;
    }

    // Verify appointment wasn't cancelled and lead didn't opt out
    if (appointmentId) {
      const appt = await db.query(
        'SELECT status FROM appointments WHERE id = ?',
        [appointmentId], 'get'
      );
      if (appt && appt.status === 'cancelled') {
        logger.info(`[reviewRequest] Skipping — appointment ${appointmentId} was cancelled`);
        return;
      }
    }

    // Check lead opt-out
    if (phone) {
      const optOut = await db.query(
        'SELECT 1 FROM sms_opt_outs WHERE phone = ? AND client_id = ?',
        [phone, clientId], 'get'
      );
      if (optOut) {
        logger.info(`[reviewRequest] Skipping — ${phone.replace(/\d(?=\d{4})/g, '*')} opted out`);
        return;
      }
    }

    // Dedup: don't send if we already sent a review request to this number in the past 30 days
    const recent = await db.query(
      `SELECT id FROM messages
       WHERE phone = ? AND client_id = ? AND direction = 'outbound'
       AND body LIKE '%review%' AND created_at > ?`,
      [phone, clientId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()], 'get'
    );
    if (recent) {
      logger.info(`[reviewRequest] Skipping — review request already sent to ${phone.replace(/\d(?=\d{4})/g, '*')} in past 30 days`);
      return;
    }

    const name = businessName || 'us';
    const message = `Hi! Thank you for choosing ${name}. We hope everything went great! If you have a moment, we'd really appreciate a quick Google review — it helps us a lot: ${googleReviewLink}`.slice(0, SMS_MAX_LENGTH);

    // Import sendSMS lazily to avoid circular deps
    const { sendSMS } = require('../../utils/sms');
    const result = await sendSMS(phone, message, from, db, clientId);

    if (result && result.success === false) {
      logger.warn(`[reviewRequest] SMS send failed for ${phone.replace(/\d(?=\d{4})/g, '*')}: ${result.error || 'unknown'}`);
      return;
    }

    logger.info(`[reviewRequest] Sent Google review request to ${phone.replace(/\d(?=\d{4})/g, '*')} for client ${clientId}`);

    // Record metric
    try {
      const { recordMetric } = require('../../utils/metrics');
      recordMetric('review_requests_sent', 1);
    } catch (_) {}

  } catch (err) {
    logger.error('[reviewRequest] Error:', { error: err.message, stack: err.stack, jobId });
    throw err;
  }
}

module.exports = { googleReviewRequest };
