const { APPOINTMENT_REMINDER_24H_MS, APPOINTMENT_REMINDER_2H_MS } = require('../../config/timing');
const { logger } = require('../logger');

function createAppointmentReminders(db, appointment, client) {
  try {
    if (!appointment || !appointment.id || !appointment.datetime) {
      logger.warn('[Scheduler] createAppointmentReminders: missing appointment data');
      return;
    }

    const apptTime = new Date(appointment.datetime);
    if (isNaN(apptTime.getTime())) {
      logger.warn('[Scheduler] Invalid appointment datetime:', appointment.datetime);
      return;
    }

    const leadId = appointment.lead_id;
    const clientId = appointment.client_id || client?.id;
    const name = appointment.name || 'there';
    const service = appointment.service || 'appointment';
    const timeStr = apptTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const businessName = client?.business_name || 'us';

    const reminders = [
      {
        touchNumber: 10,
        delayBefore: APPOINTMENT_REMINDER_24H_MS, // 24h before
        content: `Hi ${name}! Just confirming your ${service} appointment tomorrow at ${timeStr}. Reply YES to confirm or call us to reschedule.`,
      },
      {
        touchNumber: 11,
        delayBefore: APPOINTMENT_REMINDER_2H_MS, // 2h before
        content: `Reminder: Your ${service} appointment is in 2 hours at ${timeStr}. See you soon! — ${businessName}`,
      },
    ];

    const { randomUUID } = require('crypto');

    for (const r of reminders) {
      const scheduledAt = new Date(apptTime.getTime() - r.delayBefore);
      // Only schedule if in the future
      if (scheduledAt.getTime() <= Date.now()) continue;

      // Dedup
      const existing = db.prepare(
        "SELECT id FROM followups WHERE lead_id = ? AND touch_number = ? AND type = 'reminder' AND status = 'scheduled'"
      ).get(leadId, r.touchNumber);
      if (existing) continue;

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, 'reminder', ?, 'template', ?, 'scheduled')
      `).run(randomUUID(), leadId, clientId, r.touchNumber, r.content, scheduledAt.toISOString());
    }

    logger.info(`[Scheduler] Appointment reminders created for ${appointment.phone || name}`);
  } catch (err) {
    logger.error('[Scheduler] createAppointmentReminders error:', err.message);
  }
}

async function processAppointmentReminders(db) {
  try {
    const { processDueReminders } = require('../appointmentReminders');
    const { sendSMS } = require('../sms');

    await processDueReminders(db, async (phone, message, from) => {
      return sendSMS(phone, message, from, db);
    });
  } catch (err) {
    logger.error('[Scheduler] processAppointmentReminders error:', err.message);
  }
}

module.exports = { createAppointmentReminders, processAppointmentReminders };
