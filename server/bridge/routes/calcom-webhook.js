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
async function verifySignature(req, res, next) {
  try {
    const db = req.app.locals.db;
    const clientId = req.params.clientId || req.headers['x-elyvn-client-id'];
    let secret = process.env.CALCOM_WEBHOOK_SECRET;

    if (clientId) {
      const client = await db.query('SELECT calcom_webhook_secret_encrypted FROM clients WHERE id = ?', [clientId], 'get');
      if (client && client.calcom_webhook_secret_encrypted) {
        const { decrypt } = require('../utils/encryption');
        secret = decrypt(client.calcom_webhook_secret_encrypted) || secret;
      }
    }
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
  const webhookTimestamp = req.headers['x-cal-timestamp'];
  if (!webhookTimestamp) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('[calcom-webhook] Missing x-cal-timestamp header in production');
      return next(new AppError('MISSING_TIMESTAMP', 'Missing timestamp', 400));
    }
  } else {
    const ts = new Date(webhookTimestamp).getTime();
    if (!isNaN(ts) && (Date.now() - ts) > 300000) {
      logger.warn('[calcom-webhook] Webhook timestamp too old — possible replay attack');
      return next(new AppError('WEBHOOK_EXPIRED', 'Webhook expired', 400));
    }
  }
  
  return next();

  } catch (err) {
    logger.error('[calcom-webhook] Signature verification error:', err.message);
    return next(new AppError('SIGNATURE_ERROR', 'Signature error', 500));
  }
}

// POST /webhooks/calcom or /webhooks/calcom/:clientId
router.post('/:clientId?', verifySignature, async (req, res) => {
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
      await handleBookingCreated(db, payload, req);
    } else if (triggerEvent === 'BOOKING_CANCELLED') {
      await handleBookingCancelled(db, payload);
    } else if (triggerEvent === 'BOOKING_RESCHEDULED') {
      await handleBookingRescheduled(db, payload);
    }
  } catch (err) {
    logger.error('[calcom-webhook] Processing error', { code: 'PROCESSING_ERROR', triggerEvent: req.body?.triggerEvent, error: err.message });
  }
});

async function handleBookingCreated(db, payload, req) {
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
  // Priority: 1) explicit clientId from URL/headers, 2) organizer email, 3) event type ID
  let client = null;
  const explicitClientId = req.params?.clientId || req.headers?.['x-elyvn-client-id'];
  if (explicitClientId) {
    client = await db.query('SELECT * FROM clients WHERE id = ? AND is_active = 1', [explicitClientId], 'get');
  }
  if (!client && organizer?.email) {
    client = await db.query('SELECT * FROM clients WHERE owner_email = ? AND is_active = 1', [organizer.email], 'get');
  }
  // Fallback: match by calcom_event_type_id if the booking payload includes it
  if (!client && payload.eventTypeId) {
    client = await db.query('SELECT * FROM clients WHERE calcom_event_type_id = ? AND is_active = 1', [String(payload.eventTypeId)], 'get');
  }
  // Fallback: match by organizer email domain against any client with matching email domain
  if (!client && organizer?.email) {
    const domain = organizer.email.split('@')[1];
    if (domain) {
      client = await db.query("SELECT * FROM clients WHERE owner_email LIKE ? AND is_active = 1 LIMIT 1", [`%@${domain}`], 'get');
    }
  }
  if (!client && process.env.SINGLE_TENANT_MODE === 'true') {
    client = await db.query('SELECT * FROM clients WHERE is_active = 1 LIMIT 1', [], 'get');
  }

  if (!client) {
    logger.error(`[calcom-webhook] No matching client found for booking (organizer: ${organizer?.email || 'unknown'}, eventTypeId: ${payload.eventTypeId || 'none'})`);
    return;
  }

  // Create/update appointment record
  const appointmentId = randomUUID();
  try {
    await db.query(`
      INSERT INTO appointments (id, client_id, phone, name, service, datetime, status, calcom_booking_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
    `, [appointmentId, client.id, phone, name, title || 'Demo', startTime, calcomBookingId, now, now], 'run');
    try { logDataMutation(db, { action: 'appointment_created', table: 'appointments', recordId: appointmentId, clientId: client.id, newValues: { phone, name, service: title, startTime, calcomBookingId, status: 'confirmed' } }); } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
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
    if (!prospect && name && name.length >= 3) {
      // Escape LIKE wildcards to prevent SQL LIKE injection (min 3 chars to avoid overly broad match)
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
  } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

  // Send confirmation SMS if we have a phone number
  if (phone) {
    try {
      const { sendSMS } = require('../utils/sms');
      const startDate = new Date(startTime);
      const timeStr = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(startDate);
      const smsText = `Confirmed! Your appointment with ${client.business_name} is on ${timeStr}. We'll send you a reminder beforehand. Reply CANCEL to reschedule.`;
      await sendSMS(phone, smsText, client.phone_number, db, client.id);
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
          from: client.phone_number,
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
    if (client.telegram_chat_id) {
      await sendTg(client.telegram_chat_id, msg);
    }
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

  // Google Sheets: log booking
  if (client.google_sheet_id) {
    try {
      const { logBooking } = require('../utils/googleSheets');
      logBooking(client.google_sheet_id, {
        name, phone, email, service: title || 'Demo',
        start_time: startTime, status: 'confirmed',
      }).catch(e => logger.warn('[sheets] logBooking failed:', e.message));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  }
}

async function handleBookingCancelled(db, payload) {
  try {
    const { bookingId, uid } = payload;
    const calcomBookingId = String(bookingId || uid || '');
    const now = new Date().toISOString();

    // Get appointment before updating (need id for cancelling jobs)
    const appt = await db.query("SELECT id, client_id, phone FROM appointments WHERE calcom_booking_id = ?", [calcomBookingId], 'get');

    // Update appointment
    await db.query("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE calcom_booking_id = ?", [now, calcomBookingId], 'run');
    try { logDataMutation(db, { action: 'appointment_cancelled', table: 'appointments', recordId: calcomBookingId, newValues: { status: 'cancelled' } }); } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

    // Update lead stage back to contacted
    await db.query("UPDATE leads SET stage = 'contacted', updated_at = ? WHERE calcom_booking_id = ?", [now, calcomBookingId], 'run');
    try { logDataMutation(db, { action: 'lead_updated', table: 'leads', recordId: calcomBookingId, newValues: { stage: 'contacted' } }); } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

    // Cancel scheduled reminders and review requests for this appointment
    if (appt) {
      try {
        const { cancelJobs } = require('../utils/jobQueue');
        await cancelJobs(db, `reminder_${appt.id}`);
        await cancelJobs(db, `review_${appt.id}`);
      } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

      // Telegram notification to client
      try {
        const client = await db.query('SELECT telegram_chat_id, business_name FROM clients WHERE id = ?', [appt.client_id], 'get');
        if (client?.telegram_chat_id) {
          const { sendMessage } = require('../utils/telegram');
          const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
          sendMessage(client.telegram_chat_id,
            `&#10060; <b>Booking Cancelled</b>\n\n` +
            `${appt.phone ? `&#128222; ${esc(appt.phone)}` : 'Unknown contact'}\n` +
            `Booking ID: ${esc(calcomBookingId)}\n\n` +
            `Lead moved back to <b>contacted</b> stage. Follow-up reminders cancelled.`
          ).catch(e => logger.warn('[calcom-webhook] Cancel Telegram failed:', e.message));
        }
      } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
    }

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
      const cancelNow = new Date().toISOString();
      try {
        await db.query(
          `UPDATE job_queue SET status = 'cancelled', updated_at = ?
           WHERE type = 'appointment_reminder'
           AND json_extract(payload, '$.appointmentId') = ?
           AND status = 'pending'`,
          [cancelNow, appt.id], 'run'
        );
      } catch (cancelErr) {
        logger.warn('[calcom-webhook] Failed to cancel old reminders:', cancelErr.message);
      }

      // Cancel old review request job too
      try {
        await db.query(
          `UPDATE job_queue SET status = 'cancelled', updated_at = ?
           WHERE type = 'google_review_request'
           AND json_extract(payload, '$.appointmentId') = ?
           AND status = 'pending'`,
          [cancelNow, appt.id], 'run'
        );
      } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

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
          const client = await db.query('SELECT google_review_link, phone_number, business_name FROM clients WHERE id = ?', [appt.client_id], 'get');
          if (client?.google_review_link) {
            const { enqueueJob } = require('../utils/jobQueue');
            const reviewAt = new Date(new Date(endTime).getTime() + 2 * 60 * 60 * 1000).toISOString();
            await enqueueJob(db, 'google_review_request', {
              phone: appt.phone,
              clientId: appt.client_id,
              appointmentId: appt.id,
              businessName: client.business_name || client.name,
              googleReviewLink: client.google_review_link,
              from: client.phone_number,
            }, reviewAt, `review_${appt.id}`);
          }
        } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
      }
    }

    // Telegram notification for reschedule
    if (appt) {
      try {
        const notifyClient = await db.query('SELECT telegram_chat_id FROM clients WHERE id = ?', [appt.client_id], 'get');
        if (notifyClient?.telegram_chat_id) {
          const { sendMessage } = require('../utils/telegram');
          const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
          const timeStr = startTime ? new Date(startTime).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'TBD';
          sendMessage(notifyClient.telegram_chat_id,
            `&#128260; <b>Booking Rescheduled</b>\n\n` +
            `${appt.phone ? `&#128222; ${esc(appt.phone)}` : 'Unknown contact'}\n` +
            `${appt.name ? `&#128100; ${esc(appt.name)}` : ''}\n` +
            `&#128197; New time: <b>${esc(timeStr)}</b>\n\n` +
            `Reminders updated automatically.`
          ).catch(e => logger.warn('[calcom-webhook] Reschedule Telegram failed:', e.message));
        }
      } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
    }

    logger.info(`[calcom-webhook] Booking ${calcomBookingId} rescheduled to ${startTime}`);
  } catch (err) {
    logger.error('[calcom-webhook] handleBookingRescheduled error:', err);
  }
}

module.exports = router;
