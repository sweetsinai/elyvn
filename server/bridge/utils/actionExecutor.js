/**
 * Action Executor — takes brain decisions and executes them.
 * Uses sync better-sqlite3 and existing sendSMS utility.
 */
const { randomUUID } = require('crypto');
const { sendSMS } = require('./sms');
const telegram = require('./telegram');
const { logger } = require('./logger');
const { appendEvent, Events } = require('./eventStore');

async function executeActions(db, actions, leadMemory) {
  const results = [];
  const { lead, client } = leadMemory;

  for (const action of actions) {
    try {
      const result = await executeOne(db, action, lead, client);
      results.push({ action: action.action, success: true, result });

      // Fire-and-forget: emit BrainActionExecuted event
      if (lead?.id) {
        try {
          await appendEvent(db, lead.id, 'lead', Events.BrainActionExecuted, { action: action.action, details: action }, client?.id);
        } catch (_) {}
      }
    } catch (error) {
      logger.error(`[Executor] Failed ${action.action}:`, error.message);
      results.push({ action: action.action, success: false, error: error.message });
    }
  }

  return results;
}

async function executeOne(db, action, lead, client) {
  switch (action.action) {

    case 'send_sms': {
      const to = action.to || lead?.phone;
      if (!to) return { sent: false, reason: 'no phone' };

      // Check business hours and delay if necessary
      const { shouldDelayUntilBusinessHours } = require('./businessHours');
      const delay = shouldDelayUntilBusinessHours(client);

      let result;
      if (delay > 0) {
        // Queue for later
        try {
          const { enqueueJob } = require('./jobQueue');
          const scheduledAt = new Date(Date.now() + delay).toISOString();
          await enqueueJob(db, 'followup_sms', {
            phone: to,
            message: action.message,
            from: client?.phone_number,
            clientId: client?.id,
            leadId: lead?.id,
          }, scheduledAt);
          result = { success: true, scheduled: true, scheduledAt };
        } catch (err) {
          logger.error('[Executor] Job queue error:', err.message);
          result = { success: false, error: 'Failed to queue SMS' };
        }
      } else {
        result = await sendSMS(to, action.message, client?.phone_number, db, client?.id);
      }

      // Log in messages table
      if (lead?.id && result.success && !result.scheduled) {
        await db.query(`
          INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, reply_source, status, created_at)
          VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'brain', 'sent', ?)
        `, [randomUUID(), client?.id, lead.id, to, action.message, new Date().toISOString()], 'run');
      }

      // Notify owner about brain-initiated SMS (skip in digest mode)
      if (client?.telegram_chat_id && result.success && client.notification_mode !== 'digest') {
        telegram.sendMessage(client.telegram_chat_id,
          `&#129504; <b>Brain auto-sent SMS</b>\n\nTo: ${to}\n"${(action.message || '').substring(0, 200)}"${result.scheduled ? '\n\n⏱️ Scheduled for next business hours' : ''}`
        ).catch(err => logger.warn('[actionExecutor] Telegram SMS notify failed', err.message));
      }

      return { sent: result.success, sid: result.messageId, scheduled: result.scheduled };
    }

    case 'schedule_followup': {
      if (!lead?.id) return { scheduled: false };
      const id = randomUUID();
      const scheduledAt = new Date(Date.now() + (action.delay_hours || 2) * 3600000).toISOString();

      await db.query(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, 'brain', ?, 'brain', ?, 'scheduled')
      `, [id, lead.id, client?.id, action.touch_number || 1, action.message, scheduledAt], 'run');

      return { followup_id: id, scheduled_at: scheduledAt };
    }

    case 'cancel_pending_followups': {
      if (!lead?.id) return { cancelled: 0 };
      const result = await db.query(
        `UPDATE followups SET status = 'cancelled', updated_at = ? WHERE lead_id = ? AND status = 'scheduled'`,
        [new Date().toISOString(), lead.id], 'run'
      );
      return { cancelled: result.changes || 0, reason: action.reason };
    }

    case 'update_lead_stage': {
      if (!lead?.id) return { updated: false };
      const { isValidStage } = require('./validators');
      if (!isValidStage(action.stage)) {
        logger.warn(`[Executor] Invalid stage: ${action.stage}`);
        return { updated: false, error: 'invalid_stage' };
      }
      await db.query(
        `UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?`,
        [action.stage, new Date().toISOString(), lead.id], 'run'
      );
      return { new_stage: action.stage };
    }

    case 'update_lead_score': {
      if (!lead?.id) return { updated: false };
      const score = Math.max(0, Math.min(100, Number(action.score) || 0));
      await db.query(
        `UPDATE leads SET score = ?, updated_at = ? WHERE id = ?`,
        [score, new Date().toISOString(), lead.id], 'run'
      );
      return { new_score: score, reason: action.reason };
    }

    case 'notify_owner': {
      if (!client?.telegram_chat_id) return { notified: false, reason: 'no chat_id' };

      // In digest mode, only send high/critical urgency alerts
      if (client.notification_mode === 'digest' && action.urgency !== 'high' && action.urgency !== 'critical') {
        return { notified: false, reason: 'digest_mode' };
      }

      const urgencyEmoji = { low: '&#8505;&#65039;', medium: '&#9888;&#65039;', high: '&#128308;', critical: '&#128680;' };
      const emoji = urgencyEmoji[action.urgency] || '&#8505;&#65039;';

      let text = `${emoji} <b>Brain Alert</b>\n\n${action.message}`;
      if (lead?.phone) text += `\n\nLead: ${lead.name || lead.phone}`;

      try {
        const { recordMetric } = require('./metrics');
        recordMetric('total_brain_decisions', 1, 'counter');
      } catch (_) {}

      await telegram.sendMessage(client.telegram_chat_id, text);
      return { notified: true };
    }

    case 'book_appointment': {
      // Brain decided to book an appointment for the lead
      const phone = action.phone || lead?.phone;
      const email = action.email || lead?.email;
      const leadName = action.name || lead?.name || 'Guest';

      if (!phone && !email) return { booked: false, reason: 'no contact info' };

      // Try Cal.com API first
      const eventTypeId = action.event_type_id || client?.calcom_event_type_id || process.env.CALCOM_EVENT_TYPE_ID;
      if (eventTypeId && email && action.start_time) {
        try {
          const { createBooking } = require('./calcom');
          const result = await createBooking({
            eventTypeId,
            startTime: action.start_time,
            name: leadName,
            email,
            phone,
            metadata: { lead_id: lead?.id, client_id: client?.id, source: 'brain' },
          });

          if (result.success) {
            // Record appointment in DB
            const appointmentId = randomUUID();
            const now = new Date().toISOString();
            await db.query(`
              INSERT INTO appointments (id, client_id, lead_id, phone, name, service, datetime, status, calcom_booking_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
            `, [appointmentId, client?.id, lead?.id, phone, leadName, action.service || 'Demo', action.start_time, result.booking?.uid || '', now, now], 'run');

            // Update lead stage
            if (lead?.id) {
              await db.query("UPDATE leads SET stage = 'booked', score = MAX(score, 90), updated_at = ? WHERE id = ?", [now, lead.id], 'run');
            }

            // Cancel pending follow-ups
            if (lead?.id) {
              await db.query("UPDATE followups SET status = 'cancelled', updated_at = ? WHERE lead_id = ? AND status = 'scheduled'", [now, lead.id], 'run');
            }

            // Notify owner
            if (client?.telegram_chat_id) {
              telegram.sendMessage(client.telegram_chat_id,
                `📅 <b>Brain auto-booked appointment</b>\n\n${leadName} (${phone || email})\n🕐 ${action.start_time}\n📋 ${action.service || 'Demo'}`
              ).catch(err => logger.warn('[actionExecutor] Telegram booking notify failed', err.message));
            }

            return { booked: true, appointment_id: appointmentId, via: 'calcom_api' };
          }
        } catch (err) {
          logger.error('[Executor] Cal.com booking error:', err.message);
        }
      }

      // Fallback: send booking link via SMS
      const bookingLink = client?.calcom_booking_link || process.env.CALCOM_BOOKING_LINK;
      if (phone && bookingLink) {
        const smsText = `Hi ${leadName.split(' ')[0]}! Here's your booking link for ${client?.business_name || 'us'}: ${bookingLink}`;
        await sendSMS(phone, smsText, client?.phone_number, db, client?.id);
        return { booked: false, fallback: 'sms_link_sent', booking_link: bookingLink };
      }

      // Notify owner if we can't book
      if (client?.telegram_chat_id) {
        telegram.sendMessage(client.telegram_chat_id,
          `⚠️ <b>Brain wants to book but can't</b>\n\n${leadName} (${phone || email || 'no contact'})\nReason: ${!eventTypeId ? 'No event type configured' : !email ? 'No email' : 'No time slot specified'}\n\nPlease book manually.`
        ).catch(err => logger.warn('[actionExecutor] Telegram manual-book notify failed', err.message));
      }
      return { booked: false, reason: 'manual_booking_needed' };
    }

    case 'log_insight': {
      logger.info(`[Brain Insight] ${lead?.phone}: ${action.insight}`);
      return { logged: true };
    }

    case 'no_action': {
      logger.info(`[Brain] No action for ${lead?.phone}: ${action.reason}`);
      return { reason: action.reason };
    }

    default: {
      logger.warn(`[Executor] Unknown action: ${action.action}`);
      return { unknown: true };
    }
  }
}

module.exports = { executeActions };
