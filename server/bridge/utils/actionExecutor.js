/**
 * Action Executor — takes brain decisions and executes them.
 * Uses sync better-sqlite3 and existing sendSMS utility.
 */
const { randomUUID } = require('crypto');
const { sendSMS } = require('./sms');
const telegram = require('./telegram');

async function executeActions(db, actions, leadMemory) {
  const results = [];
  const { lead, client } = leadMemory;

  for (const action of actions) {
    try {
      const result = await executeOne(db, action, lead, client);
      results.push({ action: action.action, success: true, result });
    } catch (error) {
      console.error(`[Executor] Failed ${action.action}:`, error.message);
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
          enqueueJob(db, 'followup_sms', {
            phone: to,
            message: action.message,
            from: client?.twilio_phone,
            clientId: client?.id,
            leadId: lead?.id,
          }, scheduledAt);
          result = { success: true, scheduled: true, scheduledAt };
        } catch (err) {
          console.error('[Executor] Job queue error:', err.message);
          result = { success: false, error: 'Failed to queue SMS' };
        }
      } else {
        result = await sendSMS(to, action.message, client?.twilio_phone, db, client?.id);
      }

      // Log in messages table
      if (lead?.id && result.success && !result.scheduled) {
        db.prepare(`
          INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, reply_source, status, created_at)
          VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'brain', 'sent', datetime('now'))
        `).run(randomUUID(), client?.id, lead.id, to, action.message);
      }

      // Notify owner about brain-initiated SMS
      if (client?.telegram_chat_id && result.success) {
        telegram.sendMessage(client.telegram_chat_id,
          `&#129504; <b>Brain auto-sent SMS</b>\n\nTo: ${to}\n"${(action.message || '').substring(0, 200)}"${result.scheduled ? '\n\n⏱️ Scheduled for next business hours' : ''}`
        ).catch(() => {});
      }

      return { sent: result.success, sid: result.messageId, scheduled: result.scheduled };
    }

    case 'schedule_followup': {
      if (!lead?.id) return { scheduled: false };
      const id = randomUUID();
      const scheduledAt = new Date(Date.now() + (action.delay_hours || 2) * 3600000).toISOString();

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, 'brain', ?, 'brain', ?, 'scheduled')
      `).run(id, lead.id, client?.id, action.touch_number || 1, action.message, scheduledAt);

      return { followup_id: id, scheduled_at: scheduledAt };
    }

    case 'cancel_pending_followups': {
      if (!lead?.id) return { cancelled: 0 };
      const result = db.prepare(
        `UPDATE followups SET status = 'cancelled', updated_at = datetime('now') WHERE lead_id = ? AND status = 'scheduled'`
      ).run(lead.id);
      return { cancelled: result.changes || 0, reason: action.reason };
    }

    case 'update_lead_stage': {
      if (!lead?.id) return { updated: false };
      db.prepare(
        `UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(action.stage, lead.id);
      return { new_stage: action.stage };
    }

    case 'update_lead_score': {
      if (!lead?.id) return { updated: false };
      db.prepare(
        `UPDATE leads SET score = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(action.score, lead.id);
      return { new_score: action.score, reason: action.reason };
    }

    case 'notify_owner': {
      if (!client?.telegram_chat_id) return { notified: false, reason: 'no chat_id' };

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

    case 'log_insight': {
      console.log(`[Brain Insight] ${lead?.phone}: ${action.insight}`);
      return { logged: true };
    }

    case 'no_action': {
      console.log(`[Brain] No action for ${lead?.phone}: ${action.reason}`);
      return { reason: action.reason };
    }

    default: {
      console.warn(`[Executor] Unknown action: ${action.action}`);
      return { unknown: true };
    }
  }
}

module.exports = { executeActions };
