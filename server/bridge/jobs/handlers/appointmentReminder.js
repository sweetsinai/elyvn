const { logger } = require('../../utils/logger');
const { isLeadComplete } = require('../../utils/dbHelpers');
const { SMS_MAX_LENGTH } = require('../../config/timing');

/**
 * Handler: followup_sms
 * Sends a follow-up SMS from a scheduled followups sequence.
 */
async function followupSms(db, sendSMS, payload) {
  try {
    // Check if lead already booked before sending follow-up
    if (payload.leadId) {
      const lead = await db.query('SELECT stage FROM leads WHERE id = ?', [payload.leadId], 'get');
      if (isLeadComplete(lead)) {
        logger.info(`[jobQueue] Skipping followup_sms — lead ${payload.leadId} already ${lead.stage}`);
        return;
      }
    }
    // Check for recent duplicate SMS to prevent queue retry duplication
    const phone = payload.phone || payload.to;
    const recentSMS = await db.query(
      "SELECT id FROM messages WHERE phone = ? AND created_at > ? AND direction = 'outbound'",
      [phone, new Date(Date.now() - 5 * 60 * 1000).toISOString()], 'get'
    );
    if (recentSMS) {
      logger.info(`[jobHandlers] Skipping duplicate SMS to ${phone}`);
      return;
    }
    // Truncate to Twilio max for concatenated SMS
    const message = (payload.message || payload.body || '').slice(0, SMS_MAX_LENGTH);
    await sendSMS(phone, message, payload.from, db, payload.clientId);
  } catch (err) {
    logger.error('[jobHandlers] followupSms error:', { error: err.message, stack: err.stack, leadId: payload.leadId });
    throw err;
  }
}

/**
 * Handler: appointment_reminder
 * Sends an appointment reminder SMS.
 */
async function appointmentReminder(db, sendSMS, payload) {
  try {
    // Verify appointment hasn't been cancelled
    if (payload.appointmentId) {
      const appt = await db.query('SELECT status FROM appointments WHERE id = ?', [payload.appointmentId], 'get');
      if (appt && appt.status === 'cancelled') {
        logger.info(`[jobQueue] Skipping reminder — appointment ${payload.appointmentId} cancelled`);
        return;
      }
    }
    // Truncate to Twilio max for concatenated SMS
    const message = (payload.message || '').slice(0, SMS_MAX_LENGTH);
    await sendSMS(payload.phone, message, payload.from, db, payload.clientId);
  } catch (err) {
    logger.error('[jobHandlers] appointmentReminder error:', { error: err.message, stack: err.stack, appointmentId: payload.appointmentId });
    throw err;
  }
}

module.exports = { followupSms, appointmentReminder };
