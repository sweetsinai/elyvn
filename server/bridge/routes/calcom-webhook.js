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

  // Find which client this booking belongs to
  // Match by event type, organizer email, or use default client
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

  // Check if this was an outreach prospect — update prospect status
  if (email) {
    const prospect = db.prepare('SELECT * FROM prospects WHERE email = ?').get(email);
    if (prospect) {
      db.prepare("UPDATE prospects SET status = 'booked', updated_at = ? WHERE id = ?").run(now, prospect.id);
      console.log(`[calcom-webhook] Prospect ${prospect.id} (${prospect.business_name}) booked!`);

      // Cancel any pending follow-up jobs for this prospect
      try {
        const { cancelJobs } = require('../utils/jobQueue');
        cancelJobs(db, { type: 'interested_followup_email', payloadMatch: `"prospect_id":"${prospect.id}"` });
      } catch (_) {}
    }
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
