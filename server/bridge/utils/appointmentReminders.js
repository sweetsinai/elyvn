/**
 * Appointment Reminder Sequence
 * Schedules and processes appointment reminders (24h, 1h, 15min before)
 */

const { randomUUID } = require('crypto');

/**
 * Schedule reminders for an appointment (24h, 1h, 15min before)
 * @param {object} db - better-sqlite3 instance
 * @param {object} appointment - Appointment object {id, client_id, lead_id, phone, name, service, datetime}
 * @returns {boolean} Success
 */
function scheduleReminders(db, appointment) {
  if (!db || !appointment || !appointment.id || !appointment.datetime) {
    console.warn('[appointmentReminders] Missing required fields');
    return false;
  }

  try {
    const apptTime = new Date(appointment.datetime);
    if (isNaN(apptTime.getTime())) {
      console.warn('[appointmentReminders] Invalid datetime:', appointment.datetime);
      return false;
    }

    const clientId = appointment.client_id;
    const leadId = appointment.lead_id;
    const phone = appointment.phone;
    const name = appointment.name || 'there';
    const service = appointment.service || 'appointment';
    const businessName = db.prepare(
      'SELECT business_name FROM clients WHERE id = ?'
    ).get(clientId)?.business_name || 'our business';

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
        console.log(`[appointmentReminders] Skipping past reminder touch ${reminder.touchNumber}`);
        continue;
      }

      // Dedup: skip if already scheduled
      const existing = db.prepare(
        "SELECT id FROM followups WHERE lead_id = ? AND touch_number = ? AND type = 'reminder' AND status = 'scheduled'"
      ).get(leadId, reminder.touchNumber);

      if (existing) {
        console.log(`[appointmentReminders] Already scheduled touch ${reminder.touchNumber}`);
        continue;
      }

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, 'reminder', ?, 'appointment_reminder_template', ?, 'scheduled')
      `).run(
        randomUUID(),
        leadId,
        clientId,
        reminder.touchNumber,
        reminder.content,
        scheduledAt.toISOString()
      );

      scheduled++;
    }

    console.log(`[appointmentReminders] Scheduled ${scheduled} reminders for appointment ${appointment.id}`);
    return true;
  } catch (err) {
    console.error('[appointmentReminders] scheduleReminders error:', err.message);
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

  try {
    const due = db.prepare(`
      SELECT f.*, l.phone, c.telnyx_phone, c.twilio_phone
      FROM followups f
      JOIN leads l ON f.lead_id = l.id
      JOIN clients c ON f.client_id = c.id
      WHERE f.type = 'reminder'
      AND f.status = 'scheduled'
      AND f.scheduled_at <= datetime('now')
      AND f.touch_number IN (10, 11, 12)
      LIMIT 20
    `).all();

    let sent = 0;
    for (const reminder of due) {
      try {
        const fromPhone = reminder.telnyx_phone || reminder.twilio_phone;
        const result = await sendSMSFn(reminder.phone, reminder.content, fromPhone);

        if (result && result.success) {
          db.prepare(
            "UPDATE followups SET status = 'sent', sent_at = datetime('now') WHERE id = ?"
          ).run(reminder.id);
          sent++;
          console.log(`[appointmentReminders] Sent reminder ${reminder.id} to ${reminder.phone}`);
        } else {
          console.warn(`[appointmentReminders] Failed to send reminder ${reminder.id}`);
          db.prepare(
            "UPDATE followups SET status = 'failed' WHERE id = ?"
          ).run(reminder.id);
        }
      } catch (err) {
        console.error(`[appointmentReminders] Error sending reminder ${reminder.id}:`, err.message);
        db.prepare(
          "UPDATE followups SET status = 'failed' WHERE id = ?"
        ).run(reminder.id);
      }

      // Small delay between sends
      await new Promise(r => setTimeout(r, 100));
    }

    return sent;
  } catch (err) {
    console.error('[appointmentReminders] processDueReminders error:', err.message);
    return 0;
  }
}

module.exports = { scheduleReminders, processDueReminders };
