const { randomUUID } = require('crypto');
const { sendSMS } = require('./sms');
const telegram = require('./telegram');
const { normalizePhone } = require('./phone');

const RETELL_API_KEY = process.env.RETELL_API_KEY;

// Named delay constants
const TOUCH_2_DELAY_MS = 60 * 1000;       // 60 seconds
const TOUCH_3_DELAY_MS = 5 * 60 * 1000;   // 5 minutes
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
    console.error('[SpeedToLead] Missing phone or client data');
    return;
  }

  const firstName = name ? name.split(' ')[0] : null;
  const bookingLink = client.calcom_booking_link || '';
  const fromNumber = client.twilio_phone || process.env.TWILIO_PHONE_NUMBER;

  // === TOUCH 1: Instant SMS (0 seconds) ===
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

    await sendSMS(phone, smsText, fromNumber);

    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, reply_text, reply_source, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', NULL, ?, 'system', 'sent', datetime('now'), datetime('now'))
    `).run(randomUUID(), clientId, leadId, phone, smsText);

    console.log(`[SpeedToLead] Touch 1 SMS sent to ${phone}`);
  } catch (err) {
    console.error('[SpeedToLead] Touch 1 SMS failed:', err.message);
  }

  // === TOUCH 2: AI Callback (60 seconds) ===
  scheduleCallback(db, {
    leadId, clientId, phone, name, message, service,
    delayMs: 60000,
    reason: source === 'missed_call' ? 'missed_call_callback' : 'speed_callback',
    client
  });

  // === TOUCH 3: Follow-up SMS (5 minutes) ===
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
    ).catch(err => console.error('[SpeedToLead] Telegram notify failed:', err.message));
  }
}

/**
 * Schedule an AI outbound callback via Retell after a delay.
 * Checks lead stage and client is_active before firing.
 */
function scheduleCallback(db, options) {
  const { leadId, clientId, phone, name, message, service, delayMs, reason, client } = options;

  setTimeout(async () => {
    try {
      // Don't call if already booked
      const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(leadId);
      if (lead && (lead.stage === 'booked' || lead.stage === 'completed')) {
        console.log(`[SpeedToLead] Skipping callback — lead ${leadId} already at stage: ${lead.stage}`);
        return;
      }

      // Don't call if client paused AI
      const currentClient = db.prepare('SELECT is_active FROM clients WHERE id = ?').get(clientId);
      if (!currentClient || !currentClient.is_active) {
        console.log(`[SpeedToLead] Skipping callback — client ${clientId} AI is paused`);
        return;
      }

      if (!RETELL_API_KEY || !client.retell_agent_id) {
        console.error('[SpeedToLead] Cannot callback — missing RETELL_API_KEY or retell_agent_id');
        return;
      }

      const dynamicVars = {};
      if (name) dynamicVars.customer_name = name;
      if (service) dynamicVars.service_requested = service;
      if (message) dynamicVars.original_message = message.substring(0, 200);
      dynamicVars.callback_reason = reason === 'missed_call_callback'
        ? 'returning their missed call'
        : 'following up on their inquiry';

      const response = await fetch('https://api.retellai.com/v2/create-phone-call', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RETELL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from_number: client.retell_phone,
          to_number: phone,
          agent_id: client.retell_agent_id,
          retell_llm_dynamic_variables: dynamicVars,
          metadata: { lead_id: leadId, client_id: clientId, callback_type: reason }
        })
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[SpeedToLead] AI callback initiated to ${phone} — call_id: ${result.call_id}`);

        db.prepare(`
          INSERT INTO calls (id, client_id, call_id, caller_phone, direction, outcome, summary, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'outbound', 'callback_initiated', ?, datetime('now'), datetime('now'))
        `).run(randomUUID(), clientId, result.call_id || randomUUID(), phone,
          `Speed callback: ${reason}.${service ? ' Service: ' + service : ''}`);

        db.prepare(
          `UPDATE leads SET stage = 'contacted', last_contact = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        ).run(leadId);
      } else {
        const err = await response.text();
        console.error('[SpeedToLead] Retell callback failed:', response.status, err.substring(0, 200));
      }
    } catch (err) {
      console.error('[SpeedToLead] Callback error:', err.message);
    }
  }, delayMs);

  console.log(`[SpeedToLead] AI callback to ${phone} scheduled in ${delayMs / 1000}s`);
}

/**
 * Schedule a follow-up SMS if lead hasn't booked after delay.
 */
function scheduleFollowUpSMS(db, options) {
  const { leadId, clientId, phone, name, delayMs, client } = options;

  setTimeout(async () => {
    try {
      const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(leadId);
      if (lead && (lead.stage === 'booked' || lead.stage === 'completed')) {
        console.log('[SpeedToLead] Skipping follow-up SMS — lead already booked');
        return;
      }

      const currentClient = db.prepare('SELECT is_active FROM clients WHERE id = ?').get(clientId);
      if (!currentClient || !currentClient.is_active) return;

      const firstName = name ? name.split(' ')[0] : null;
      const bookingLink = client.calcom_booking_link || '';
      const fromNumber = client.twilio_phone || process.env.TWILIO_PHONE_NUMBER;

      const followUpText = `Hi${firstName ? ' ' + firstName : ''}, I just tried reaching you from ${client.business_name}. ` +
        `No worries if now's not a good time! ` +
        (bookingLink ? `Book whenever works: ${bookingLink}` : `Just reply and we'll set something up.`);

      await sendSMS(phone, followUpText, fromNumber);

      db.prepare(`
        INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, reply_text, reply_source, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'sms', 'outbound', NULL, ?, 'system', 'sent', datetime('now'), datetime('now'))
      `).run(randomUUID(), clientId, leadId, phone, followUpText);

      console.log(`[SpeedToLead] Touch 3 follow-up SMS sent to ${phone}`);
    } catch (err) {
      console.error('[SpeedToLead] Follow-up SMS error:', err.message);
    }
  }, delayMs);
}

module.exports = { triggerSpeedSequence, scheduleCallback, scheduleFollowUpSMS };
