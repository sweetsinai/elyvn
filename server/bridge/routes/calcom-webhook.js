/**
 * Cal.com Webhook Handler
 * Captures booking created/cancelled events so elyvn knows when
 * a prospect books directly via the Cal.com link (from cold email, SMS, etc.)
 */
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');

// POST /webhooks/calcom
router.post('/', async (req, res) => {
  // Always respond 200 fast
  res.status(200).json({ received: true });

  try {
    const db = req.app.locals.db;
    const { triggerEvent, payload } = req.body;

    if (!triggerEvent || !payload) {
      console.log('[calcom-webhook] Missing triggerEvent or payload');
      return;
    }

    console.log(`[calcom-webhook] Event: ${triggerEvent}`);

    if (triggerEvent === 'BOOKING_CREATED') {
      await handleBookingCreated(db, payload);
    } else if (triggerEvent === 'BOOKING_CANCELLED') {
      await handleBookingCancelled(db, payload);
    } else if (triggerEvent === 'BOOKING_RESCHEDULED') {
      await handleBookingRescheduled(db, payload);
    }
  } catch (err) {
    console.error('[calcom-webhook] Error processing event:', err);
  }
});

async function handleBookingCreated(db, payload) {
  const {
    bookingId,
    uid,
    title,
    startTime,
    endTime,
    attendees = [],
    organizer,
    metadata,
  } = payload;

  const attendee = attendees[0] || {};
  const email = attendee.email;
  const name = attendee.name || '';
  const phone = attendee.phone || metadata?.phone || null;

  console.log(`[calcom-webhook] Booking created: ${name} (${email}) at ${startTime}`);

  const now = new Date().toISOString();
  const calcomBookingId = String(bookingId || uid || '');

  // === IDEMPOTENCY CHECK — skip if this booking was already processed ===
  if (calcomBookingId) {
    const existing = db.prepare('SELECT id FROM appointments WHERE calcom_booking_id = ?').get(calcomBookingId);
    if (existing) {
      console.log(`[calcom-webhook] Booking ${calcomBookingId} already processed (idempotent skip)`);
      return;
    }
  }

  // Find which client this booking belongs to
  // Match by organizer email first, then fall back to single-tenant default
  let client = null;
  if (organizer?.email) {
    client = db.prepare('SELECT * FROM clients WHERE owner_email = ? AND is_active = 1').get(organizer.email);
  }
  if (!client) {
    // Fall back to first active client (for single-tenant setups)
    client = db.prepare('SELECT * FROM clients WHERE is_active = 1 LIMIT 1').get();
  }

  if (!client) {
    console.error('[calcom-webhook] No matching client found for booking');
    return;
  }

  // Create/update appointment record
  const appointmentId = randomUUID();
  try {
    db.prepare(`
      INSERT INTO appointments (id, client_id, phone, name, service, datetime, status, calcom_booking_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
    `).run(appointmentId, client.id, phone, name, title || 'Demo', startTime, calcomBookingId, now, now);
  } catch (err) {
    if (!err.message.includes('UNIQUE')) {
      console.error('[calcom-webhook] Insert appointment error:', err.message);
    }
  }

  // Upsert lead — if they booked, they're hot
  if (phone || email) {
    const lookupField = phone ? 'phone' : 'email';
    const lookupValue = phone || email;

    const existingLead = db.prepare(
      `SELECT * FROM leads WHERE client_id = ? AND ${lookupField} = ?`
    ).get(client.id, lookupValue);

    if (existingLead) {
      db.prepare(`
        UPDATE leads SET stage = 'booked', score = MAX(score, 9), calcom_booking_id = ?,
        name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone),
        last_contact = ?, updated_at = ? WHERE id = ?
      `).run(calcomBookingId, name || null, email || null, phone || null, now, now, existingLead.id);
      console.log(`[calcom-webhook] Lead ${existingLead.id} updated to booked`);
    } else if (phone) {
      const leadId = randomUUID();
      db.prepare(`
        INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, calcom_booking_id, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'calcom', 9, 'booked', ?, ?, ?, ?)
      `).run(leadId, client.id, name, phone, email, calcomBookingId, now, now, now);
      console.log(`[calcom-webhook] New lead ${leadId} created from Cal.com booking`);
    }
  }

  // Check if this was an outreach prospect — match by email in multiple ways
  let prospect = null;
  if (email) {
    // Try 1: Direct match on prospects.email
    prospect = db.prepare('SELECT * FROM prospects WHERE email = ?').get(email);

    // Try 2: Match via emails_sent.to_email (prospect may have been emailed at a different address)
    if (!prospect) {
      const sentEmail = db.prepare(`
        SELECT es.prospect_id FROM emails_sent es
        WHERE es.to_email = ? AND es.prospect_id IS NOT NULL
        LIMIT 1
      `).get(email);
      if (sentEmail?.prospect_id) {
        prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(sentEmail.prospect_id);
      }
    }

    // Try 3: Match by attendee name against prospect business_name
    if (!prospect && name) {
      prospect = db.prepare('SELECT * FROM prospects WHERE business_name LIKE ? LIMIT 1').get(`%${name}%`);
    }
  }

  if (prospect) {
    db.prepare("UPDATE prospects SET status = 'booked', updated_at = ? WHERE id = ?").run(now, prospect.id);
    console.log(`[calcom-webhook] Prospect ${prospect.id} (${prospect.business_name}) booked!`);

    // Link the lead to the prospect if a lead was just created/updated
    try {
      const lead = db.prepare(
        "SELECT id FROM leads WHERE calcom_booking_id = ? LIMIT 1"
      ).get(calcomBookingId);
      if (lead) {
        db.prepare("UPDATE leads SET prospect_id = ?, source = COALESCE(source, 'outreach'), updated_at = ? WHERE id = ?")
          .run(prospect.id, now, lead.id);
      }
    } catch (_) {}

    // Cancel any pending follow-up jobs for this prospect
    try {
      const { cancelJobs } = require('../utils/jobQueue');
      cancelJobs(db, { payloadContains: `"prospect_id":"${prospect.id}"` });
      cancelJobs(db, { type: 'noreply_followup', payloadContains: prospect.id });
    } catch (_) {}
  }

  // Send confirmation SMS if we have a phone number
  if (phone) {
    try {
      const { sendSMS } = require('../utils/sms');
      const startDate = new Date(startTime);
      const timeStr = startDate.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const smsText = `Confirmed! Your appointment with ${client.business_name} is on ${timeStr}. We'll send you a reminder beforehand. Reply CANCEL to reschedule.`;
      await sendSMS(db, phone, smsText, client.id);
      console.log(`[calcom-webhook] Confirmation SMS sent to ${phone}`);
    } catch (err) {
      console.error('[calcom-webhook] Confirmation SMS failed:', err.message);
    }
  }

  // Schedule appointment reminders
  try {
    const { scheduleReminders } = require('../utils/appointmentReminders');
    scheduleReminders(db, {
      id: appointmentId,
      client_id: client.id,
      phone,
      name,
      datetime: startTime,
      service: title || 'Demo',
    });
    console.log(`[calcom-webhook] Reminders scheduled for appointment ${appointmentId}`);
  } catch (err) {
    console.error('[calcom-webhook] Failed to schedule reminders:', err.message);
  }

  // Notify owner via Telegram
  try {
    const { sendTelegramNotification } = require('../utils/telegram');
    const startDate = new Date(startTime);
    const timeStr = startDate.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const msg = `📅 *New Booking!*\n\n*${name || 'Someone'}* just booked!\n📧 ${email || 'No email'}\n📱 ${phone || 'No phone'}\n📋 ${title || 'Demo'}\n🕐 ${timeStr}\n\nConfirmation SMS sent automatically.`;
    await sendTelegramNotification(msg, client.telegram_chat_id);
  } catch (err) {
    console.error('[calcom-webhook] Telegram notification failed:', err.message);
  }
}

async function handleBookingCancelled(db, payload) {
  const { bookingId, uid } = payload;
  const calcomBookingId = String(bookingId || uid || '');
  const now = new Date().toISOString();

  // Update appointment
  db.prepare("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE calcom_booking_id = ?").run(now, calcomBookingId);

  // Update lead stage back to contacted
  db.prepare("UPDATE leads SET stage = 'contacted', updated_at = ? WHERE calcom_booking_id = ?").run(now, calcomBookingId);

  console.log(`[calcom-webhook] Booking ${calcomBookingId} cancelled`);
}

async function handleBookingRescheduled(db, payload) {
  const { bookingId, uid, startTime } = payload;
  const calcomBookingId = String(bookingId || uid || '');
  const now = new Date().toISOString();

  db.prepare("UPDATE appointments SET datetime = ?, updated_at = ? WHERE calcom_booking_id = ?").run(startTime, now, calcomBookingId);

  console.log(`[calcom-webhook] Booking ${calcomBookingId} rescheduled to ${startTime}`);
}

module.exports = router;
