/**
 * Job handlers for the queue processor
 * These handlers are called by the job queue processor when processing enqueued jobs
 */

const { randomUUID } = require('crypto');
const { getTransporter } = require('./mailer');
const config = require('./config');

// Create job handlers object
function createJobHandlers(db, sendSMS, captureException) {
  return {
    'speed_to_lead_sms': async (payload) => {
      // Check if lead already booked/completed before sending
      if (payload.leadId) {
        const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(payload.leadId);
        if (lead && (lead.stage === 'booked' || lead.stage === 'completed')) {
          console.log(`[jobQueue] Skipping speed_to_lead_sms — lead ${payload.leadId} already ${lead.stage}`);
          return;
        }
      }
      // Check for recent duplicate SMS to prevent queue retry duplication
      const recentSMS = db.prepare(
        "SELECT id FROM messages WHERE phone = ? AND created_at > datetime('now', '-5 minutes') AND direction = 'outbound'"
      ).get(payload.phone);
      if (recentSMS) {
        console.log(`[jobHandlers] Skipping duplicate SMS to ${payload.phone}`);
        return;
      }
      // Truncate to Twilio max for concatenated SMS
      const message = (payload.message || '').slice(0, 1600);
      await sendSMS(payload.phone, message, payload.from, db, payload.clientId);
    },
    'speed_to_lead_callback': async (payload) => {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(payload.clientId);
      if (!client) {
        console.error(`[jobQueue] speed_to_lead_callback — client ${payload.clientId} not found`);
        return;
      }
      // Check if lead already booked before making the callback
      const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(payload.leadId);
      if (lead && (lead.stage === 'booked' || lead.stage === 'completed')) {
        console.log(`[jobQueue] Skipping callback — lead ${payload.leadId} already ${lead.stage}`);
        return;
      }
      // Check if AI is active
      if (!client.is_active) {
        console.log(`[jobQueue] Skipping callback — AI paused for client ${payload.clientId}`);
        return;
      }
      // Check for recent duplicate call to prevent queue retry duplication
      const recentCall = db.prepare(
        "SELECT id FROM calls WHERE phone = ? AND created_at > datetime('now', '-5 minutes')"
      ).get(payload.phone);
      if (recentCall) {
        console.log(`[jobHandlers] Skipping duplicate call to ${payload.phone}`);
        return;
      }
      // Actually make the Retell outbound call
      const agentId = payload.retell_agent_id || client.retell_agent_id;
      const fromPhone = payload.retell_phone || client.retell_phone;
      if (!agentId || !fromPhone || !payload.phone) {
        console.warn(`[jobQueue] speed_to_lead_callback — missing agent_id (${agentId}), from (${fromPhone}), or to (${payload.phone})`);
        // Fallback: send SMS instead
        const smsMsg = `Hi${payload.name ? ' ' + payload.name.split(' ')[0] : ''}! We tried calling you from ${client.business_name || 'us'}. ${client.calcom_booking_link ? 'Book at: ' + client.calcom_booking_link : 'Call us back when you can!'}`.slice(0, 1600);
        await sendSMS(payload.phone, smsMsg, client.twilio_phone, db, client.id);
        return;
      }
      const RETELL_API_KEY = process.env.RETELL_API_KEY;
      if (!RETELL_API_KEY) {
        console.warn('[jobQueue] No RETELL_API_KEY — cannot make outbound call');
        return;
      }
      try {
        const resp = await fetch('https://api.retellai.com/v2/create-phone-call', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RETELL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from_number: fromPhone,
            to_number: payload.phone,
            agent_id: agentId,
            metadata: { lead_id: payload.leadId, client_id: payload.clientId, reason: payload.reason || 'speed_callback' },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (resp.ok) {
          const data = await resp.json();
          console.log(`[jobQueue] Retell outbound call created: ${data.call_id || 'ok'} to ${payload.phone}`);
        } else {
          const errText = await resp.text().catch(() => '');
          console.error(`[jobQueue] Retell create-phone-call failed (${resp.status}): ${errText}`);
          // Fallback SMS
          const fallbackMsg = `Hi${payload.name ? ' ' + payload.name.split(' ')[0] : ''}! We tried to reach you from ${client.business_name || 'us'}. ${client.calcom_booking_link ? 'Book at: ' + client.calcom_booking_link : 'Call us back!'}`.slice(0, 1600);
          await sendSMS(payload.phone, fallbackMsg, client.twilio_phone, db, client.id);
        }
      } catch (callErr) {
        console.error(`[jobQueue] Retell outbound call error:`, callErr.message);
        if (captureException) {
          captureException(callErr, { context: 'speed_to_lead_callback', leadId: payload.leadId });
        }
      }
    },
    'followup_sms': async (payload) => {
      // Check if lead already booked before sending follow-up
      if (payload.leadId) {
        const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(payload.leadId);
        if (lead && (lead.stage === 'booked' || lead.stage === 'completed')) {
          console.log(`[jobQueue] Skipping followup_sms — lead ${payload.leadId} already ${lead.stage}`);
          return;
        }
      }
      // Check for recent duplicate SMS to prevent queue retry duplication
      const phone = payload.phone || payload.to;
      const recentSMS = db.prepare(
        "SELECT id FROM messages WHERE phone = ? AND created_at > datetime('now', '-5 minutes') AND direction = 'outbound'"
      ).get(phone);
      if (recentSMS) {
        console.log(`[jobHandlers] Skipping duplicate SMS to ${phone}`);
        return;
      }
      // Truncate to Twilio max for concatenated SMS
      const message = (payload.message || payload.body || '').slice(0, 1600);
      await sendSMS(phone, message, payload.from, db, payload.clientId);
    },
    'appointment_reminder': async (payload) => {
      // Verify appointment hasn't been cancelled
      if (payload.appointmentId) {
        const appt = db.prepare('SELECT status FROM appointments WHERE id = ?').get(payload.appointmentId);
        if (appt && appt.status === 'cancelled') {
          console.log(`[jobQueue] Skipping reminder — appointment ${payload.appointmentId} cancelled`);
          return;
        }
      }
      // Truncate to Twilio max for concatenated SMS
      const message = (payload.message || '').slice(0, 1600);
      await sendSMS(payload.phone, message, payload.from, db, payload.clientId);
    },
    'interested_followup_email': async (payload) => {
      try {
        // 24h follow-up for INTERESTED prospects who haven't booked yet
        const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(payload.prospect_id);
        if (!prospect || prospect.status === 'booked') {
          console.log(`[jobQueue] Skipping follow-up — prospect ${payload.prospect_id} already booked or gone`);
          return;
        }
        // Check if they booked an appointment since we enqueued
        const hasBooking = db.prepare(
          "SELECT 1 FROM appointments WHERE phone = ? OR lead_id = ? LIMIT 1"
        ).get(prospect.phone, payload.prospect_id);
        if (hasBooking) {
          console.log(`[jobQueue] Skipping follow-up — prospect ${payload.prospect_id} has a booking`);
          return;
        }
        // Check for recent duplicate email to prevent queue retry duplication
        const recentEmail = db.prepare(
          "SELECT id FROM emails_sent WHERE to_email = ? AND prospect_id = ? AND created_at > datetime('now', '-5 minutes')"
        ).get(payload.to_email, payload.prospect_id);
        if (recentEmail) {
          console.log(`[jobHandlers] Skipping duplicate email to ${payload.to_email}`);
          return;
        }
        const transport = getTransporter();
        if (!transport) {
          console.error('[jobQueue] SMTP not configured for interested_followup');
          return;
        }
        const BOOKING_LINK = payload.booking_link || config.outreach.bookingLink;
        const SENDER = payload.sender_name || config.outreach.senderName;
        const body = `Hi${prospect.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nJust following up — I know things get busy! The demo is only 10 minutes and I'll show you exactly how ELYVN handles calls for businesses like yours.\n\nHere's the link again: ${BOOKING_LINK}\n\nNo pressure at all — happy to answer any questions too.\n\n${SENDER}\nELYVN`;
        await transport.sendMail({
          from: payload.from_email,
          to: payload.to_email,
          subject: `Re: ${payload.subject}`,
          text: body,
          html: body.replace(/\n/g, '<br>'),
        });
        console.log(`[jobQueue] Sent 24h interested follow-up to ${payload.to_email}`);
      } catch (err) {
        console.error('[jobQueue] interested_followup_email error:', err.message);
        if (captureException) {
          captureException(err, { context: 'interested_followup_email', prospectId: payload.prospect_id });
        }
      }
    },
    'noreply_followup': async (payload) => {
      try {
        // Follow-up for prospects who never replied (Day 3 or Day 7)
        const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(payload.prospect_id);
        if (!prospect || ['bounced', 'unsubscribed', 'booked', 'interested'].includes(prospect.status)) {
          console.log(`[jobQueue] Skipping no-reply follow-up — prospect ${payload.prospect_id} status: ${prospect?.status}`);
          return;
        }
        // Check if they replied since we enqueued
        const hasReply = db.prepare(
          "SELECT 1 FROM emails_sent WHERE prospect_id = ? AND reply_text IS NOT NULL LIMIT 1"
        ).get(payload.prospect_id);
        if (hasReply) {
          console.log(`[jobQueue] Skipping no-reply follow-up — prospect replied`);
          return;
        }
        // Check for recent duplicate email to prevent queue retry duplication
        const recentEmail = db.prepare(
          "SELECT id FROM emails_sent WHERE to_email = ? AND prospect_id = ? AND created_at > datetime('now', '-5 minutes')"
        ).get(payload.to_email, payload.prospect_id);
        if (recentEmail) {
          console.log(`[jobHandlers] Skipping duplicate email to ${payload.to_email}`);
          return;
        }
        const transport = getTransporter();
        if (!transport) {
          console.error('[jobQueue] SMTP not configured for noreply_followup');
          return;
        }
        const BOOKING_LINK = payload.booking_link || config.outreach.bookingLink;
        const SENDER = payload.sender_name || config.outreach.senderName;
        const dayNum = payload.day || 3;
        let body;
        if (dayNum <= 3) {
          body = `Hi${prospect.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nQuick follow-up on my earlier email. I work with ${prospect.industry || 'service'} businesses in ${prospect.city || 'your area'} and thought ELYVN could help you catch calls you might be missing.\n\nWould a 10-minute demo be worth your time? ${BOOKING_LINK}\n\n${SENDER}\nELYVN`;
        } else {
          body = `Hi${prospect.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nLast note from me — I don't want to be a pest! If now's not the right time, no worries.\n\nBut if you're curious how an AI receptionist could help ${prospect.business_name || 'your business'} handle after-hours calls and book more appointments, the link below takes 10 minutes:\n\n${BOOKING_LINK}\n\nEither way, I wish you all the best.\n\n${SENDER}\nELYVN`;
        }
        await transport.sendMail({
          from: payload.from_email,
          to: payload.to_email,
          subject: `Re: ${payload.original_subject}`,
          text: body,
          html: body.replace(/\n/g, '<br>'),
        });
        // Record in emails_sent
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, status, sent_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
        `).run(randomUUID(), payload.campaign_id || null, payload.prospect_id, payload.to_email, payload.from_email, `Re: ${payload.original_subject}`, body, now, now, now);
        console.log(`[jobQueue] Sent Day ${dayNum} no-reply follow-up to ${payload.to_email}`);
        // If this was Day 3, schedule Day 7
        if (dayNum <= 3) {
          const { enqueueJob } = require('./jobQueue');
          enqueueJob(db, 'noreply_followup', {
            ...payload,
            day: 7,
          }, new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString());
        }
      } catch (err) {
        console.error('[jobQueue] noreply_followup error:', err.message);
        if (captureException) {
          captureException(err, { context: 'noreply_followup', prospectId: payload.prospect_id });
        }
      }
    },
  };
}

module.exports = { createJobHandlers };
