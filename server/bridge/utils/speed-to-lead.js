const { randomUUID } = require('crypto');
const { sendSMS } = require('./sms');
const telegram = require('./telegram');
const { normalizePhone } = require('./phone');
const { logger } = require('./logger');
const { appendEvent, Events } = require('./eventStore');

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

  // P1: Double trigger prevention — skip if active sequence already exists for this lead
  const activeSpeed = await db.query(`
    SELECT 1 FROM followups
    WHERE lead_id = ? AND status = 'scheduled'
    AND scheduled_at > datetime('now', '-6 hours')
    LIMIT 1
  `, [leadId], 'get');
  if (activeSpeed) {
    logger.info(`[SpeedToLead] Active sequence found for lead ${leadId} — skipping duplicate trigger`);
    return;
  }

  // P1: Lead name sanitization for SMS
  const safeName = (name || '').replace(/[\r\n\t<>{}]/g, '').substring(0, 50);
  const firstName = safeName.split(' ')[0] || '';
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

    await enqueueJob(db, 'speed_to_lead_sms', { phone, message: smsText, from: fromNumber, clientId, leadId }, scheduledAt, `stl_sms_${leadId}`, 10);

    await db.query(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, reply_text, reply_source, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', NULL, ?, 'system', 'sent', datetime('now'), datetime('now'))
    `, [randomUUID(), clientId, leadId, phone, smsText], 'run');

    logger.info(`[SpeedToLead] Touch 1 SMS queued for ${phone}`);
  } catch (err) {
    logger.error('[SpeedToLead] Touch 1 SMS failed:', err.message);
  }

  // === TOUCH 2: AI Callback (smart timing or 60s fallback) ===
  let callbackDelay = 60000;
  try {
    const { getOptimalContactTime } = require('./smartScheduler');
    const timing = await getOptimalContactTime(db, leadId, clientId);
    if (timing && timing.confidence > 0.5) {
      const now = new Date();
      const optimal = new Date();
      optimal.setHours(timing.optimal_hour, 0, 0, 0);
      if (optimal <= now) optimal.setDate(optimal.getDate() + 1);
      const delay = optimal.getTime() - now.getTime();
      if (delay > 60000 && delay < 24 * 60 * 60 * 1000) {
        callbackDelay = delay;
        logger.info(`[SpeedToLead] Smart timing: callback in ${Math.round(delay / 60000)}min (optimal hour: ${timing.optimal_hour})`);
      }
    }
  } catch (err) {
    logger.warn('[SpeedToLead] Smart scheduler unavailable, using 60s default:', err.message);
  }
  await scheduleCallback(db, {
    leadId, clientId, phone, name, message, service,
    delayMs: callbackDelay,
    reason: source === 'missed_call' ? 'missed_call_callback' : 'speed_callback',
    client
  });

  // === TOUCH 3: Follow-up SMS (5 min AFTER the callback, not a hardcoded 5min from now) ===
  const touch3DelayMs = callbackDelay + (5 * 60 * 1000); // always 5 min AFTER the callback
  await scheduleFollowUpSMS(db, { leadId, clientId, phone, name, delayMs: touch3DelayMs, client });

  // === TOUCH 4/5: Standard follow-ups (24h + 72h) — dedup by touch_number ===
  try {
    const now = Date.now();
    const tomorrow = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const threeDays = new Date(now + 72 * 60 * 60 * 1000).toISOString();

    const has4 = await db.query("SELECT id FROM followups WHERE lead_id = ? AND touch_number = 4 AND status = 'scheduled'", [leadId], 'get');
    if (!has4) {
      await db.query(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, 4, 'reminder_or_nudge', NULL, 'pending', ?, 'scheduled')
      `, [randomUUID(), leadId, clientId, tomorrow], 'run');

      try {
        await appendEvent(db, leadId, 'lead', Events.FollowupScheduled, {
          touch_number: 4, type: 'reminder_or_nudge', scheduled_at: tomorrow,
        }, clientId);
      } catch (_) {}
    }

    const has5 = await db.query("SELECT id FROM followups WHERE lead_id = ? AND touch_number = 5 AND status = 'scheduled'", [leadId], 'get');
    if (!has5) {
      await db.query(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, 5, 'review_or_final', NULL, 'pending', ?, 'scheduled')
      `, [randomUUID(), leadId, clientId, threeDays], 'run');

      try {
        await appendEvent(db, leadId, 'lead', Events.FollowupScheduled, {
          touch_number: 5, type: 'review_or_final', scheduled_at: threeDays,
        }, clientId);
      } catch (_) {}
    }
  } catch (err) {
    logger.error('[SpeedToLead] Follow-up insert failed:', err.message);
  }

  // === Telegram notification (skip in digest mode) ===
  if (client.telegram_chat_id && client.notification_mode !== 'digest') {
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
      `\n✅ Instant SMS sent\n` +
      `✅ AI callback scheduled (${callbackDelay < 120000 ? Math.round(callbackDelay / 1000) + 's' : Math.round(callbackDelay / 60000) + 'min'})\n` +
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
async function scheduleCallback(db, options) {
  const { leadId, clientId, phone, name, message, service, delayMs, reason, client } = options;

  try {
    const { enqueueJob } = require('./jobQueue');
    const { shouldDelayUntilBusinessHours } = require('./businessHours');

    // Add business hours delay to the scheduled time
    const businessHoursDelay = shouldDelayUntilBusinessHours(client);
    const totalDelayMs = Math.max(delayMs, businessHoursDelay);
    const scheduledAt = new Date(Date.now() + totalDelayMs).toISOString();

    await enqueueJob(db, 'speed_to_lead_callback', {
      leadId, clientId, phone, name, message, service, reason,
      retell_agent_id: client.retell_agent_id,
      retell_phone: client.retell_phone,
    }, scheduledAt, `stl_cb_${leadId}`, 10);

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
async function scheduleFollowUpSMS(db, options) {
  const { leadId, clientId, phone, name, delayMs, client } = options;

  try {
    const { enqueueJob } = require('./jobQueue');
    const { shouldDelayUntilBusinessHours } = require('./businessHours');

    const safeName = (name || '').replace(/[\r\n\t<>{}]/g, '').substring(0, 50);
    const firstName = safeName.split(' ')[0] || '';
    const bookingLink = client.calcom_booking_link || '';
    const fromNumber = client.telnyx_phone || client.twilio_phone; // Use telnyx_phone, fallback to twilio_phone for backwards compat

    const followUpText = `Hi${firstName ? ' ' + firstName : ''}, I just tried reaching you from ${client.business_name}. ` +
      `No worries if now's not a good time! ` +
      (bookingLink ? `Book whenever works: ${bookingLink}` : `Just reply and we'll set something up.`);

    const businessHoursDelay = shouldDelayUntilBusinessHours(client);
    const totalDelayMs = Math.max(delayMs, businessHoursDelay);
    const scheduledAt = new Date(Date.now() + totalDelayMs).toISOString();

    await enqueueJob(db, 'followup_sms', {
      phone, message: followUpText, from: fromNumber, clientId, leadId,
    }, scheduledAt);

    logger.info(`[SpeedToLead] Touch 3 follow-up SMS queued for ${phone}`);
  } catch (err) {
    logger.error('[SpeedToLead] scheduleFollowUpSMS error (job queue unavailable):', err.message);
    logger.error(`[SpeedToLead] DROPPED follow-up SMS for lead ${leadId} phone ${phone} — fix job queue!`);
  }
}

module.exports = { triggerSpeedSequence, scheduleCallback, scheduleFollowUpSMS };
