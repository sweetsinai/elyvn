/**
 * Appointment Reminder Sequence
 * Schedules and processes appointment reminders (24h, 1h, 15min before)
 */

const { randomUUID } = require('crypto');
const { logger } = require('./logger');

/**
 * Schedule reminders for an appointment (24h, 1h, 15min before)
 * @param {object} db - better-sqlite3 instance
 * @param {object} appointment - Appointment object {id, client_id, lead_id, phone, name, service, datetime}
 * @returns {boolean} Success
 */
async function scheduleReminders(db, appointment) {
  if (!db || !appointment || !appointment.id || !appointment.datetime) {
    logger.warn('[appointmentReminders] Missing required fields');
    return false;
  }

  try {
    const apptTime = new Date(appointment.datetime);
    if (isNaN(apptTime.getTime())) {
      logger.warn('[appointmentReminders] Invalid datetime:', appointment.datetime);
      return false;
    }

    const clientId = appointment.client_id;
    const leadId = appointment.lead_id;
    const phone = appointment.phone;
    const name = appointment.name || 'there';
    const service = appointment.service || 'appointment';
    const clientRow = await db.query(
      'SELECT business_name FROM clients WHERE id = ?',
      [clientId], 'get'
    );
    const businessName = clientRow?.business_name || 'our business';

    const timeStr = apptTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    const dateStr = apptTime.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });

    const reminders = [
      {
        touchNumber: 10,
        delayMs: 24 * 60 * 60 * 1000,
        content: `Hi ${name}, reminder: you have a ${service} appointment tomorrow at ${timeStr}. Reply YES to confirm or CANCEL to reschedule. — ${businessName}`,
      },
      {
        touchNumber: 11,
        delayMs: 1 * 60 * 60 * 1000,
        content: `Hi ${name}, your ${service} appointment is in 1 hour at ${timeStr}. See you soon! — ${businessName}`,
      },
      {
        touchNumber: 12,
        delayMs: 15 * 60 * 1000,
        content: `${businessName}: Your appointment starts in 15 minutes at ${timeStr}. We're ready for you!`,
      },
    ];

    let scheduled = 0;
    for (const reminder of reminders) {
      const scheduledAt = new Date(apptTime.getTime() - reminder.delayMs);

      // Only schedule if in the future
      if (scheduledAt.getTime() <= Date.now()) {
        logger.info(`[appointmentReminders] Skipping past reminder touch ${reminder.touchNumber}`);
        continue;
      }

      // Dedup: skip if already scheduled
      const existing = await db.query(
        "SELECT id FROM followups WHERE lead_id = ? AND touch_number = ? AND type = 'reminder' AND status = 'scheduled'",
        [leadId, reminder.touchNumber], 'get'
      );

      if (existing) {
        logger.info(`[appointmentReminders] Already scheduled touch ${reminder.touchNumber}`);
        continue;
      }

      await db.query(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, 'reminder', ?, 'appointment_reminder_template', ?, 'scheduled')
      `, [
        randomUUID(),
        leadId,
        clientId,
        reminder.touchNumber,
        reminder.content,
        scheduledAt.toISOString()
      ], 'run');

      scheduled++;
    }

    logger.info(`[appointmentReminders] Scheduled ${scheduled} reminders for appointment ${appointment.id}`);
    return true;
  } catch (err) {
    logger.error('[appointmentReminders] scheduleReminders error:', err.message);
    return false;
  }
}

/**
 * Process due reminders and send them
 * @param {object} db - better-sqlite3 instance
 * @param {function} sendSMSFn - async function(phone, message) to send SMS
 * @returns {Promise<number>} Count of reminders sent
 */
async function processDueReminders(db, sendSMSFn) {
  if (!db || !sendSMSFn) return 0;

  const now = new Date().toISOString();
  try {
    const due = await db.query(`
      SELECT f.*, l.phone, c.phone_number
      FROM followups f
      JOIN leads l ON f.lead_id = l.id
      JOIN clients c ON f.client_id = c.id
      WHERE f.type = 'reminder'
      AND f.status = 'scheduled'
      AND f.scheduled_at <= ?
      AND f.touch_number IN (10, 11, 12)
      LIMIT 20
    `, [now]);

    let sent = 0;
    for (const reminder of due) {
      try {
        const fromPhone = reminder.phone_number;
        const result = await sendSMSFn(reminder.phone, reminder.content, fromPhone, reminder.client_id);

        if (result && result.success) {
          await db.query(
            "UPDATE followups SET status = 'sent', sent_at = ? WHERE id = ?",
            [now, reminder.id], 'run'
          );
          sent++;
          logger.info(`[appointmentReminders] Sent reminder ${reminder.id} to ${reminder.phone}`);
        } else {
          logger.warn(`[appointmentReminders] Failed to send reminder ${reminder.id}`);
          // P2: Retry on failure — reschedule up to 3 attempts, then mark failed
          const attempts = (reminder.attempts || 0) + 1;
          if (attempts < 3) {
            const retryAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min later
            await db.query(
              "UPDATE followups SET attempts = ?, scheduled_at = ? WHERE id = ?",
              [attempts, retryAt, reminder.id], 'run'
            );
            logger.info(`[appointmentReminders] Rescheduled reminder ${reminder.id} (attempt ${attempts}/3) for ${retryAt}`);
          } else {
            await db.query(
              "UPDATE followups SET status = 'failed', attempts = ? WHERE id = ?",
              [attempts, reminder.id], 'run'
            );
            logger.warn(`[appointmentReminders] Reminder ${reminder.id} permanently failed after ${attempts} attempts`);
          }
        }
      } catch (err) {
        logger.error(`[appointmentReminders] Error sending reminder ${reminder.id}:`, err.message);
        // P2: Retry on exception as well
        const attempts = (reminder.attempts || 0) + 1;
        if (attempts < 3) {
          const retryAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await db.query(
            "UPDATE followups SET attempts = ?, scheduled_at = ? WHERE id = ?",
            [attempts, retryAt, reminder.id], 'run'
          );
          logger.info(`[appointmentReminders] Rescheduled reminder ${reminder.id} after error (attempt ${attempts}/3)`);
        } else {
          await db.query(
            "UPDATE followups SET status = 'failed', attempts = ? WHERE id = ?",
            [attempts, reminder.id], 'run'
          );
        }
      }

      // Small delay between sends
      await new Promise(r => setTimeout(r, 100));
    }

    return sent;
  } catch (err) {
    logger.error('[appointmentReminders] processDueReminders error:', err.message);
    return 0;
  }
}

module.exports = { scheduleReminders, processDueReminders };
