const { randomUUID } = require('crypto');
const { sendSMS } = require('./sms');
const telegram = require('./telegram');
const { normalizePhone } = require('./phone');
const { logger } = require('./logger');

const RETELL_API_KEY = process.env.RETELL_API_KEY;

// Named delay constants
const TOUCH_2_DELAY_MS = 2 * 60 * 1000;   // 2 minutes (gives prospect time to read SMS first)
const TOUCH_3_DELAY_MS = 10 * 60 * 1000;  // 10 minutes (gives prospect time to book from callback)
const FOLLOWUP_24H_MS = 24 * 60 * 60 * 1000;
const FOLLOWUP_72H_MS = 72 * 60 * 60 * 1000;

/**
 * Trigger the full speed-to-lead sequence for a new lead from ANY channel.
 * Touch 1 (0s):   SMS with booking link
 * Touch 2 (60s):  AI callback via Retell
 * Touch 3 (5min): Follow-up SMS if no booking
 * Touch 4/5:      Insert 24h + 72h followups into followups table
 *
 * @param {object} db - better-sqlite3 sync db instance
 * @param {object} leadData - { leadId, clientId, phone, name, email, message, service, source, client }
 */
async function triggerSpeedSequence(db, leadData) {
  const { leadId, clientId, phone, name, email, message, service, source, client } = leadData;

  if (!phone || !client) {
    logger.error('[SpeedToLead] Missing phone or client data');
    return;
  }

  const firstName = name ? name.split(' ')[0] : null;
  const bookingLink = client.calcom_booking_link || '';
  const fromNumber = client.telnyx_phone || client.twilio_phone; // Use telnyx_phone, fallback to twilio_phone for backwards compat

  // === TOUCH 1: Instant SMS (0 seconds, but respect business hours) ===
  try {
    let smsText;
    if (source === 'form' && service) {
      smsText = `Hi${firstName ? ' ' + firstName : ''}! Thanks for reaching out to ${client.business_name} about ${service}. ` +
        (bookingLink ? `Book your appointment: ${bookingLink} — ` : '') +
        `or we'll call you in about a minute!`;
    } else if (source === 'missed_call') {
      smsText = `Sorry we missed your call to ${client.business_name}! ` +
        (bookingLink ? `Book instantly: ${bookingLink} — or ` : '') +
        `we'll call you back in about a minute.`;
    } else {
      smsText = `Hi${firstName ? ' ' + firstName : ''}! Thanks for contacting ${client.business_name}. ` +
        (bookingLink ? `Book anytime: ${bookingLink} — ` : '') +
        `we'll be in touch shortly!`;
    }

    const { enqueueJob } = require('./jobQueue');
    const { shouldDelayUntilBusinessHours } = require('./businessHours');
    const delayMs = shouldDelayUntilBusinessHours(client);
    const scheduledAt = new Date(Date.now() + delayMs).toISOString();

    enqueueJob(db, 'speed_to_lead_sms', { phone, message: smsText, from: fromNumber, clientId, leadId }, scheduledAt);

    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, reply_text, reply_source, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', NULL, ?, 'system', 'sent', datetime('now'), datetime('now'))
    `).run(randomUUID(), clientId, leadId, phone, smsText);

    logger.info(`[SpeedToLead] Touch 1 SMS queued for ${phone}`);
  } catch (err) {
    logger.error('[SpeedToLead] Touch 1 SMS failed:', err.message);
  }

  // === TOUCH 2: AI Callback (60 seconds, but respect business hours) ===
  scheduleCallback(db, {
    leadId, clientId, phone, name, message, service,
    delayMs: 60000,
    reason: source === 'missed_call' ? 'missed_call_callback' : 'speed_callback',
    client
  });

  // === TOUCH 3: Follow-up SMS (5 minutes, but respect business hours) ===
  scheduleFollowUpSMS(db, { leadId, clientId, phone, name, delayMs: 300000, client });

  // === TOUCH 4/5: Standard follow-ups (24h + 72h) — dedup by touch_number ===
  try {
    const now = Date.now();
    const tomorrow = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const threeDays = new Date(now + 72 * 60 * 60 * 1000).toISOString();

    const has4 = db.prepare("SELECT id FROM followups WHERE lead_id = ? AND touch_number = 4 AND status = 'scheduled'").get(leadId);
    if (!has4) {
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, 4, 'reminder_or_nudge', NULL, 'pending', ?, 'scheduled')
      `).run(randomUUID(), leadId, clientId, tomorrow);
    }

    const has5 = db.prepare("SELECT id FROM followups WHERE lead_id = ? AND touch_number = 5 AND status = 'scheduled'").get(leadId);
    if (!has5) {
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, 5, 'review_or_final', NULL, 'pending', ?, 'scheduled')
      `).run(randomUUID(), leadId, clientId, threeDays);
    }
  } catch (err) {
    console.error('[SpeedToLead] Follow-up insert failed:', err.message);
  }

  // === Telegram notification ===
  if (client.telegram_chat_id) {
    const sourceLabel = {
      'form': '📋 Website form',
      'missed_call': '📵 Missed call',
      'sms': '💬 SMS inquiry',
    }[source] || '📥 New lead';

    telegram.sendMessage(
      client.telegram_chat_id,
      `⚡ <b>Speed-to-lead activated</b>\n\n` +
      `<b>Source:</b> ${sourceLabel}\n` +
      (name ? `<b>Name:</b> ${name}\n` : '') +
      `<b>Phone:</b> ${phone}\n` +
      (email ? `<b>Email:</b> ${email}\n` : '') +
      (service ? `<b>Service:</b> ${service}\n` : '') +
      (message ? `<b>Message:</b> "${String(message).substring(0, 150)}"\n` : '') +
      `\n✅ Instant SMS sent (0 sec)\n` +
      `✅ AI callback scheduled (60 sec)\n` +
      `✅ Follow-up SMS queued (5 min)\n\n` +
      `<i>Triple-touch sequence running.</i>`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '⏸ Cancel sequence', callback_data: `cancel_speed:${leadId}` }
          ]]
        }
      }
    ).catch(err => logger.error('[SpeedToLead] Telegram notify failed:', err.message));
  }
}

/**
 * Schedule an AI outbound callback via Retell after a delay.
 * Checks lead stage and client is_active before firing.
 */
function scheduleCallback(db, options) {
  const { leadId, clientId, phone, name, message, service, delayMs, reason, client } = options;

  try {
    const { enqueueJob } = require('./jobQueue');
    const { shouldDelayUntilBusinessHours } = require('./businessHours');

    // Add business hours delay to the scheduled time
    const businessHoursDelay = shouldDelayUntilBusinessHours(client);
    const totalDelayMs = Math.max(delayMs, businessHoursDelay);
    const scheduledAt = new Date(Date.now() + totalDelayMs).toISOString();

    enqueueJob(db, 'speed_to_lead_callback', {
      leadId, clientId, phone, name, message, service, reason,
      retell_agent_id: client.retell_agent_id,
      retell_phone: client.retell_phone,
    }, scheduledAt);

    logger.info(`[SpeedToLead] AI callback to ${phone} queued for ${totalDelayMs / 1000}s`);
  } catch (err) {
    logger.error('[SpeedToLead] scheduleCallback error (job queue unavailable):', err.message);
    // No setTimeout fallback — jobs lost on restart are unacceptable in production.
    // Log a clear error so it's visible in monitoring.
    logger.error(`[SpeedToLead] DROPPED callback for lead ${leadId} phone ${phone} — fix job queue!`);
  }
}

/**
 * Schedule a follow-up SMS if lead hasn't booked after delay.
 */
function scheduleFollowUpSMS(db, options) {
  const { leadId, clientId, phone, name, delayMs, client } = options;

  try {
    const { enqueueJob } = require('./jobQueue');
    const { shouldDelayUntilBusinessHours } = require('./businessHours');

    const firstName = name ? name.split(' ')[0] : null;
    const bookingLink = client.calcom_booking_link || '';
    const fromNumber = client.telnyx_phone || client.twilio_phone; // Use telnyx_phone, fallback to twilio_phone for backwards compat

    const followUpText = `Hi${firstName ? ' ' + firstName : ''}, I just tried reaching you from ${client.business_name}. ` +
      `No worries if now's not a good time! ` +
      (bookingLink ? `Book whenever works: ${bookingLink}` : `Just reply and we'll set something up.`);

    const businessHoursDelay = shouldDelayUntilBusinessHours(client);
    const totalDelayMs = Math.max(delayMs, businessHoursDelay);
    const scheduledAt = new Date(Date.now() + totalDelayMs).toISOString();

    enqueueJob(db, 'followup_sms', {
      phone, message: followUpText, from: fromNumber, clientId, leadId,
    }, scheduledAt);

    logger.info(`[SpeedToLead] Touch 3 follow-up SMS queued for ${phone}`);
  } catch (err) {
    logger.error('[SpeedToLead] scheduleFollowUpSMS error (job queue unavailable):', err.message);
    logger.error(`[SpeedToLead] DROPPED follow-up SMS for lead ${leadId} phone ${phone} — fix job queue!`);
  }
}

module.exports = { triggerSpeedSequence, scheduleCallback, scheduleFollowUpSMS };
