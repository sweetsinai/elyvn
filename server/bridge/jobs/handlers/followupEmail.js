const { randomUUID } = require('crypto');
const { getTransporter } = require('../../utils/mailer');
const config = require('../../utils/config');
const { logger } = require('../../utils/logger');

/**
 * Handler: interested_followup_email
 * Sends a 24-hour follow-up email to INTERESTED prospects who haven't booked yet.
 */
async function interestedFollowupEmail(db, captureException, payload) {
  try {
    const prospect = await db.query('SELECT * FROM prospects WHERE id = ?', [payload.prospect_id], 'get');
    if (!prospect || prospect.status === 'booked') {
      logger.info(`[jobQueue] Skipping follow-up — prospect ${payload.prospect_id} already booked or gone`);
      return;
    }
    // Check if they booked an appointment since we enqueued
    const hasBooking = await db.query(
      "SELECT 1 FROM appointments WHERE phone = ? OR lead_id = ? LIMIT 1",
      [prospect.phone, payload.prospect_id], 'get'
    );
    if (hasBooking) {
      logger.info(`[jobQueue] Skipping follow-up — prospect ${payload.prospect_id} has a booking`);
      return;
    }
    // Check for recent duplicate email to prevent queue retry duplication
    const recentEmail = await db.query(
      "SELECT id FROM emails_sent WHERE to_email = ? AND prospect_id = ? AND created_at > ?",
      [payload.to_email, payload.prospect_id, new Date(Date.now() - 5 * 60 * 1000).toISOString()], 'get'
    );
    if (recentEmail) {
      logger.info(`[jobHandlers] Skipping duplicate email to ${payload.to_email}`);
      return;
    }
    const transport = getTransporter();
    if (!transport) {
      logger.error('[jobQueue] SMTP not configured for interested_followup');
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
    logger.info(`[jobQueue] Sent 24h interested follow-up to ${payload.to_email}`);
  } catch (err) {
    logger.error('[jobQueue] interested_followup_email error:', err.message);
    if (captureException) {
      captureException(err, { context: 'interested_followup_email', prospectId: payload.prospect_id });
    }
  }
}

/**
 * Handler: noreply_followup
 * Follow-up email for prospects who never replied (Day 3 or Day 7).
 */
async function noreplyFollowup(db, captureException, payload) {
  try {
    const prospect = await db.query('SELECT * FROM prospects WHERE id = ?', [payload.prospect_id], 'get');
    if (!prospect || ['bounced', 'unsubscribed', 'booked', 'interested'].includes(prospect.status)) {
      logger.info(`[jobQueue] Skipping no-reply follow-up — prospect ${payload.prospect_id} status: ${prospect?.status}`);
      return;
    }
    // Check if they replied since we enqueued
    const hasReply = await db.query(
      "SELECT 1 FROM emails_sent WHERE prospect_id = ? AND reply_text IS NOT NULL LIMIT 1",
      [payload.prospect_id], 'get'
    );
    if (hasReply) {
      logger.info(`[jobQueue] Skipping no-reply follow-up — prospect replied`);
      return;
    }
    // Check for recent duplicate email to prevent queue retry duplication
    const recentEmail = await db.query(
      "SELECT id FROM emails_sent WHERE to_email = ? AND prospect_id = ? AND created_at > ?",
      [payload.to_email, payload.prospect_id, new Date(Date.now() - 5 * 60 * 1000).toISOString()], 'get'
    );
    if (recentEmail) {
      logger.info(`[jobHandlers] Skipping duplicate email to ${payload.to_email}`);
      return;
    }
    const transport = getTransporter();
    if (!transport) {
      logger.error('[jobQueue] SMTP not configured for noreply_followup');
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
    await db.query(`
      INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, status, sent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
    `, [randomUUID(), payload.campaign_id || null, payload.prospect_id, payload.to_email, payload.from_email, `Re: ${payload.original_subject}`, body, now, now, now], 'run');
    logger.info(`[jobQueue] Sent Day ${dayNum} no-reply follow-up to ${payload.to_email}`);
    // If this was Day 3, schedule Day 7
    if (dayNum <= 3) {
      const { enqueueJob } = require('../../utils/jobQueue');
      await enqueueJob(db, 'noreply_followup', {
        ...payload,
        day: 7,
      }, new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(), `noreply_d7_${payload.prospect_id}`);
    }
  } catch (err) {
    logger.error('[jobQueue] noreply_followup error:', err.message);
    if (captureException) {
      captureException(err, { context: 'noreply_followup', prospectId: payload.prospect_id });
    }
  }
}

module.exports = { interestedFollowupEmail, noreplyFollowup };
