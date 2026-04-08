/**
 * Cal.com Webhook Handler
 * Captures booking created/cancelled events so elyvn knows when
 * a prospect books directly via the Cal.com link (from cold email, SMS, etc.)
 */
const express = require('express');
const router = express.Router();
const { randomUUID, createHmac } = require('crypto');
const { logger } = require('../utils/logger');
const { appendEvent, Events } = require('../utils/eventStore');
const { logDataMutation } = require('../utils/auditLog');
const { AppError } = require('../utils/AppError');

// Cal.com webhook signature verification (timing-safe comparison)
router.use((req, res, next) => {
  const secret = process.env.CALCOM_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[calcom-webhook] CALCOM_WEBHOOK_SECRET not configured in production');
      return next(new AppError('WEBHOOK_NOT_CONFIGURED', 'Webhook not configured', 500));
    }
    logger.warn('[calcom-webhook] Webhook signature validation disabled - set CALCOM_WEBHOOK_SECRET');
    return next();
  }
  const signature = req.headers['x-cal-signature-256'];
  if (!signature) {
    logger.warn('[calcom-webhook] Missing webhook signature header');
    return next(new AppError('MISSING_SIGNATURE', 'Missing signature', 401));
  }
  const payload = JSON.stringify(req.body);
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  // Use timingSafeEqual to prevent timing attacks
  const { timingSafeEqual } = require('crypto');
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    logger.warn('[calcom-webhook] Invalid webhook signature');
    return next(new AppError('INVALID_SIGNATURE', 'Invalid signature', 401));
  }

  // Timestamp validation — reject webhooks older than 5 minutes
  const webhookTimestamp = req.headers['x-cal-timestamp'] || req.body?.createdAt;
  if (webhookTimestamp) {
    const ts = new Date(webhookTimestamp).getTime();
    if (!isNaN(ts) && (Date.now() - ts) > 300000) {
      logger.warn('[calcom-webhook] Webhook timestamp too old — possible replay attack');
      return next(new AppError('WEBHOOK_EXPIRED', 'Webhook expired', 400));
    }
  }

  next();
});

// POST /webhooks/calcom
router.post('/', async (req, res) => {
  // Always respond 200 fast
  res.status(200).json({ received: true });

  try {
    const db = req.app.locals.db;
    const { triggerEvent, payload } = req.body;

    if (!triggerEvent || !payload) {
      logger.info('[calcom-webhook] Missing triggerEvent or payload');
      return;
    }

    logger.info(`[calcom-webhook] Event: ${triggerEvent}`);

    if (triggerEvent === 'BOOKING_CREATED') {
      await handleBookingCreated(db, payload);
    } else if (triggerEvent === 'BOOKING_CANCELLED') {
      await handleBookingCancelled(db, payload);
    } else if (triggerEvent === 'BOOKING_RESCHEDULED') {
      await handleBookingRescheduled(db, payload);
    }
  } catch (err) {
    logger.error('[calcom-webhook] Processing error', { code: 'PROCESSING_ERROR', triggerEvent: req.body?.triggerEvent, error: err.message });
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

  logger.info(`[calcom-webhook] Booking created: ${(name || '').replace(/./g, (c, i) => i < 2 ? c : '*').slice(0, 12)} at ${startTime}`);

  const now = new Date().toISOString();
  const calcomBookingId = String(bookingId || uid || '');

  // === IDEMPOTENCY CHECK — skip if this booking was already processed ===
  if (calcomBookingId) {
    const existing = await db.query('SELECT id FROM appointments WHERE calcom_booking_id = ?', [calcomBookingId], 'get');
    if (existing) {
      logger.info(`[calcom-webhook] Booking ${calcomBookingId} already processed (idempotent skip)`);
      return;
    }
  }

  // Find which client this booking belongs to
  // Match by organizer email first, then fall back to single-tenant default
  let client = null;
  if (organizer?.email) {
    client = await db.query('SELECT * FROM clients WHERE owner_email = ? AND is_active = 1', [organizer.email], 'get');
  }
  if (!client && process.env.SINGLE_TENANT_MODE === 'true') {
    // Single-tenant fallback — only enabled via explicit env flag
    client = await db.query('SELECT * FROM clients WHERE is_active = 1 LIMIT 1', [], 'get');
  }

  if (!client) {
    logger.error('[calcom-webhook] No matching client found for booking');
    return;
  }

  // Create/update appointment record
  const appointmentId = randomUUID();
  try {
    await db.query(`
      INSERT INTO appointments (id, client_id, phone, name, service, datetime, status, calcom_booking_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
    `, [appointmentId, client.id, phone, name, title || 'Demo', startTime, calcomBookingId, now, now], 'run');
    try { logDataMutation(db, { action: 'client_created', table: 'appointments', recordId: appointmentId, clientId: client.id, newValues: { phone, name, service: title, startTime, calcomBookingId, status: 'confirmed' } }); } catch (_) {}
  } catch (err) {
    if (!err.message.includes('UNIQUE')) {
      logger.error('[calcom-webhook] Insert appointment error:', err.message);
    }
  }

  // Upsert lead — if they booked, they're hot
  if (phone || email) {
    const lookupField = phone ? 'phone' : 'email';
    if (!['phone', 'email'].includes(lookupField)) throw new Error('Invalid lookup field');
    const lookupValue = phone || email;

    const existingLead = await db.query(
      `SELECT * FROM leads WHERE client_id = ? AND ${lookupField} = ?`,
      [client.id, lookupValue],
      'get'
    );

    if (existingLead) {
      await db.query(`
        UPDATE leads SET stage = 'booked', score = MAX(score, 9), calcom_booking_id = ?,
        name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone),
        last_contact = ?, updated_at = ? WHERE id = ?
      `, [calcomBookingId, name || null, email || null, phone || null, now, now, existingLead.id], 'run');
      logger.info(`[calcom-webhook] Lead ${existingLead.id} updated to booked`);
    } else if (phone) {
      const leadId = randomUUID();
      await db.query(`
        INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, calcom_booking_id, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'calcom', 9, 'booked', ?, ?, ?, ?)
      `, [leadId, client.id, name, phone, email, calcomBookingId, now, now, now], 'run');
      logger.info(`[calcom-webhook] New lead ${leadId} created from Cal.com booking`);
    }
  }

  // Check if this was an outreach prospect — match by email in multiple ways
  let prospect = null;
  if (email) {
    // Try 1: Direct match on prospects.email
    prospect = await db.query('SELECT * FROM prospects WHERE email = ?', [email], 'get');

    // Try 2: Match via emails_sent.to_email (prospect may have been emailed at a different address)
    if (!prospect) {
      const sentEmail = await db.query(`
        SELECT es.prospect_id FROM emails_sent es
        WHERE es.to_email = ? AND es.prospect_id IS NOT NULL
        LIMIT 1
      `, [email], 'get');
      if (sentEmail?.prospect_id) {
        prospect = await db.query('SELECT * FROM prospects WHERE id = ?', [sentEmail.prospect_id], 'get');
      }
    }

    // Try 3: Match by attendee name against prospect business_name
    if (!prospect && name) {
      // Escape LIKE wildcards to prevent SQL LIKE injection
      const escapedName = name.replace(/[%_\\]/g, '\\$&');
      prospect = await db.query("SELECT * FROM prospects WHERE business_name LIKE ? ESCAPE '\\' LIMIT 1", [`%${escapedName}%`], 'get');
    }
  }

  if (prospect) {
    await db.query("UPDATE prospects SET status = 'booked', updated_at = ? WHERE id = ?", [now, prospect.id], 'run');
    logger.info(`[calcom-webhook] Prospect ${prospect.id} (${prospect.business_name}) booked!`);

    // Link the lead to the prospect if a lead was just created/updated
    try {
      const lead = await db.query(
        "SELECT id FROM leads WHERE calcom_booking_id = ? LIMIT 1",
        [calcomBookingId],
        'get'
      );
      if (lead) {
        await db.query(
          "UPDATE leads SET prospect_id = ?, source = COALESCE(source, 'outreach'), updated_at = ? WHERE id = ?",
          [prospect.id, now, lead.id],
          'run'
        );
      }
    } catch (err) {
      logger.error('[calcom-webhook] Failed to link prospect to lead:', err.message);
    }

    // Cancel any pending follow-up jobs for this prospect
    try {
      const { cancelJobs } = require('../utils/jobQueue');
      cancelJobs(db, { payloadContains: `"prospect_id":"${prospect.id}"` });
      cancelJobs(db, { type: 'noreply_followup', payloadContains: prospect.id });
    } catch (err) {
      logger.error('[calcom-webhook] Failed to cancel jobs:', err.message);
    }
  }

  // Fire-and-forget: AppointmentBooked event
  try {
    const bookedLead = await db.query("SELECT id FROM leads WHERE calcom_booking_id = ? LIMIT 1", [calcomBookingId], 'get');
    const evtAggId = bookedLead?.id || appointmentId;
    appendEvent(db, evtAggId, 'lead', Events.AppointmentBooked, {
      phone, email, name, service: title, startTime, calcomBookingId,
    }, client.id);
  } catch (_) {}

  // Send confirmation SMS if we have a phone number
  if (phone) {
    try {
      const { sendSMS } = require('../utils/sms');
      const startDate = new Date(startTime);
      const timeStr = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(startDate);
      const smsText = `Confirmed! Your appointment with ${client.business_name} is on ${timeStr}. We'll send you a reminder beforehand. Reply CANCEL to reschedule.`;
      await sendSMS(phone, smsText, client.twilio_phone, db, client.id);
      logger.info(`[calcom-webhook] Confirmation SMS sent to ${(phone || '').replace(/\d(?=\d{4})/g, '*')}`);
    } catch (err) {
      logger.error('[calcom-webhook] Confirmation SMS failed:', err.message);
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
    logger.info(`[calcom-webhook] Reminders scheduled for appointment ${appointmentId}`);
  } catch (err) {
    logger.error('[calcom-webhook] Failed to schedule reminders:', err.message);
  }

  // Schedule Google Review request — sent 2h after appointment end time
  if (phone && client.google_review_link && endTime) {
    try {
      const { enqueueJob } = require('../utils/jobQueue');
      const reviewAt = new Date(new Date(endTime).getTime() + 2 * 60 * 60 * 1000).toISOString();
      await enqueueJob(
        db,
        'google_review_request',
        {
          phone,
          clientId: client.id,
          leadId: null,
          appointmentId,
          businessName: client.business_name || client.name,
          googleReviewLink: client.google_review_link,
          from: client.twilio_phone,
        },
        reviewAt,
        `review_${appointmentId}`
      );
      logger.info(`[calcom-webhook] Review request scheduled for ${(phone || '').replace(/\d(?=\d{4})/g, '*')} at ${reviewAt}`);
    } catch (err) {
      logger.error('[calcom-webhook] Failed to schedule review request:', err.message);
    }
  }

  // Notify owner via Telegram
  try {
    const { sendMessage: sendTg } = require('../utils/telegram');
    const startDate = new Date(startTime);
    const timeStr = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(startDate);
    const safeName = (name || 'Someone').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeEmail = (email || 'No email').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safePhone = (phone || 'No phone').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeTitle = (title || 'Demo').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const msg = `&#128197; <b>New Booking!</b>\n\n<b>${safeName}</b> just booked!\n&#128231; ${safeEmail}\n&#128241; ${safePhone}\n&#128203; ${safeTitle}\n&#128336; ${timeStr}\n\nConfirmation SMS sent automatically.`;
    await sendTg(client.telegram_chat_id, msg);
  } catch (err) {
    logger.error('[calcom-webhook] Telegram notification failed:', err.message);
  }

  // Outbound webhook: notify client CRM/callback URL if configured
  if (client.booking_webhook_url) {
    try {
      const { enqueue } = require('../utils/webhookQueue');
      await enqueue(
        client.booking_webhook_url,
        {
          event: 'booking.created',
          clientId: client.id,
          appointmentId,
          calcomBookingId,
          attendee: { name, email, phone },
          service: title || 'Demo',
          startTime,
          endTime,
        },
        { 'X-Client-Id': client.id }
      );
    } catch (err) {
      logger.error('[calcom-webhook] Webhook enqueue failed:', err.message);
    }
  }
}

async function handleBookingCancelled(db, payload) {
  try {
    const { bookingId, uid } = payload;
    const calcomBookingId = String(bookingId || uid || '');
    const now = new Date().toISOString();

    // Update appointment
    await db.query("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE calcom_booking_id = ?", [now, calcomBookingId], 'run');
    try { logDataMutation(db, { action: 'client_updated', table: 'appointments', recordId: calcomBookingId, newValues: { status: 'cancelled' } }); } catch (_) {}

    // Update lead stage back to contacted
    await db.query("UPDATE leads SET stage = 'contacted', updated_at = ? WHERE calcom_booking_id = ?", [now, calcomBookingId], 'run');
    try { logDataMutation(db, { action: 'lead_updated', table: 'leads', recordId: calcomBookingId, newValues: { stage: 'contacted' } }); } catch (_) {}

    logger.info(`[calcom-webhook] Booking ${calcomBookingId} cancelled`);
  } catch (err) {
    logger.error('[calcom-webhook] handleBookingCancelled error:', err);
  }
}

async function handleBookingRescheduled(db, payload) {
  try {
    const { bookingId, uid, startTime, endTime } = payload;
    const calcomBookingId = String(bookingId || uid || '');
    const now = new Date().toISOString();

    // Update the appointment datetime
    await db.query("UPDATE appointments SET datetime = ?, updated_at = ? WHERE calcom_booking_id = ?", [startTime, now, calcomBookingId], 'run');

    // Get the appointment record to reschedule reminders
    const appt = await db.query(
      'SELECT id, client_id, phone, name, service FROM appointments WHERE calcom_booking_id = ?',
      [calcomBookingId], 'get'
    );

    if (appt) {
      // Cancel old reminder jobs for this appointment
      try {
        await db.query(
          `UPDATE job_queue SET status = 'cancelled', updated_at = datetime('now')
           WHERE type = 'appointment_reminder'
           AND json_extract(payload, '$.appointmentId') = ?
           AND status = 'pending'`,
          [appt.id], 'run'
        );
      } catch (cancelErr) {
        logger.warn('[calcom-webhook] Failed to cancel old reminders:', cancelErr.message);
      }

      // Cancel old review request job too
      try {
        await db.query(
          `UPDATE job_queue SET status = 'cancelled', updated_at = datetime('now')
           WHERE type = 'google_review_request'
           AND json_extract(payload, '$.appointmentId') = ?
           AND status = 'pending'`,
          [appt.id], 'run'
        );
      } catch (_) {}

      // Schedule new reminders for the updated time
      try {
        const { scheduleReminders } = require('../utils/appointmentReminders');
        scheduleReminders(db, {
          id: appt.id,
          client_id: appt.client_id,
          phone: appt.phone,
          name: appt.name,
          datetime: startTime,
          service: appt.service,
        });
      } catch (schedErr) {
        logger.warn('[calcom-webhook] Failed to reschedule reminders:', schedErr.message);
      }

      // Reschedule review request if client has a review link
      if (endTime && appt.phone) {
        try {
          const client = await db.query('SELECT google_review_link, twilio_phone, business_name, name FROM clients WHERE id = ?', [appt.client_id], 'get');
          if (client?.google_review_link) {
            const { enqueueJob } = require('../utils/jobQueue');
            const reviewAt = new Date(new Date(endTime).getTime() + 2 * 60 * 60 * 1000).toISOString();
            await enqueueJob(db, 'google_review_request', {
              phone: appt.phone,
              clientId: appt.client_id,
              appointmentId: appt.id,
              businessName: client.business_name || client.name,
              googleReviewLink: client.google_review_link,
              from: client.twilio_phone,
            }, reviewAt, `review_${appt.id}`);
          }
        } catch (_) {}
      }
    }

    logger.info(`[calcom-webhook] Booking ${calcomBookingId} rescheduled to ${startTime}`);
  } catch (err) {
    logger.error('[calcom-webhook] handleBookingRescheduled error:', err);
  }
}

module.exports = router;
