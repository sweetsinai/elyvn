const express = require('express');
const { OUTREACH_BATCH_DELAY_MS, OUTREACH_INITIAL_REPLY_TIMEOUT_MS, OUTREACH_IMAP_LOOKBACK_MS, OUTREACH_DELAY_3_DAYS_MS, OUTREACH_DELAY_1_DAY_MS, OUTREACH_COLD_EMAIL_INTERVAL_MS } = require('../config/timing');
const router = express.Router();
const { getTransporter } = require('../utils/mailer');
const config = require('../utils/config');
const { logger } = require('../utils/logger');
const { logDataMutation } = require('../utils/auditLog');
const { emailSendLimit } = require('../middleware/rateLimits');
const { AppError } = require('../utils/AppError');

const DAILY_SEND_LIMIT = config.outreach.dailySendLimit;

// PUT /campaign/:campaignId/email/:emailId
router.put('/campaign/:campaignId/email/:emailId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { campaignId, emailId } = req.params;
    const { subject, body } = req.body;

    const emailRecord = await db.query('SELECT client_id FROM emails_sent WHERE id = ?', [emailId], 'get');
    if (!emailRecord) return next(new AppError('NOT_FOUND', 'Email not found', 404));
    if (!req.isAdmin && emailRecord.client_id !== req.clientId) return next(new AppError('FORBIDDEN', 'Access denied', 403));

    if (subject && subject.length > 200) return next(new AppError('INVALID_INPUT', 'Subject too long (max 200 chars)', 400));
    if (body && body.length > 50000) return next(new AppError('INVALID_INPUT', 'Body too long (max 50000 chars)', 400));

    const result = await db.query(`
      UPDATE emails_sent SET subject = COALESCE(?, subject), body = COALESCE(?, body), updated_at = ?
      WHERE id = ? AND campaign_id = ?
    `, [subject || null, body || null, new Date().toISOString(), emailId, campaignId], 'run');

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const email = await db.query('SELECT * FROM emails_sent WHERE id = ?', [emailId], 'get');
    try { logDataMutation(db, { action: 'client_updated', table: 'emails_sent', recordId: emailId, newValues: { subject, body } }); } catch (_) {}
    res.json({ email });
  } catch (err) {
    logger.error('[outreach] edit email error:', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// POST /campaign/:campaignId/send — 20/min per client (SMTP sending is expensive)
router.post('/campaign/:campaignId/send', emailSendLimit, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { campaignId } = req.params;

    // Verify campaign belongs to this client
    if (!req.isAdmin) {
      const campaign = await db.query('SELECT client_id FROM campaigns WHERE id = ?', [campaignId], 'get');
      if (!campaign) return next(new AppError('NOT_FOUND', 'Campaign not found', 404));
      if (campaign.client_id !== req.clientId) return next(new AppError('FORBIDDEN', 'Access denied', 403));
    }

    // Check daily send limit
    const today = new Date().toISOString().split('T')[0];
    const sentTodayResult = await db.query(
      "SELECT COUNT(*) as count FROM emails_sent WHERE status = 'sent' AND sent_at >= ?",
      [today + 'T00:00:00.000Z'],
      'get'
    );
    const sentToday = sentTodayResult.count;

    const remaining = DAILY_SEND_LIMIT - sentToday;
    if (remaining <= 0) {
      return res.status(429).json({ error: `Daily send limit reached (${DAILY_SEND_LIMIT}/day)`, sent_today: sentToday });
    }

    // Get draft emails for this campaign
    const drafts = await db.query(
      "SELECT * FROM emails_sent WHERE campaign_id = ? AND status = 'draft' LIMIT ?",
      [campaignId, remaining],
      'all'
    );

    if (!drafts.length) {
      return res.status(400).json({ error: 'No draft emails to send' });
    }

    const transport = getTransporter();
    const { verifyEmail } = require('../utils/emailVerifier');
    let sent = 0;
    let failed = 0;
    let skippedInvalid = 0;

    const sanitizeHeader = s => String(s || '').replace(/[\r\n]/g, '');
    const { generateTrackingPixel, wrapLinksWithTracking } = require('../utils/emailTracking');
    const { wrapWithCTA } = require('../utils/emailTemplates');

    // Batch concurrent email sending for improved throughput
    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = OUTREACH_BATCH_DELAY_MS;

    // Helper function to verify and send a single email
    const sendEmailAsync = async (email) => {
      try {
        // Verify email before sending
        try {
          const verification = await verifyEmail(email.to_email);
          if (!verification.valid) {
            logger.info(`[outreach] Skipping invalid email ${email.to_email}: ${verification.reason}`);
            await db.query("UPDATE emails_sent SET status = 'invalid', error = ?, updated_at = ? WHERE id = ?",
              [`verification_failed: ${verification.reason}`, new Date().toISOString(), email.id], 'run');
            await db.query("UPDATE prospects SET status = 'invalid_email', updated_at = ? WHERE id = ?",
              [new Date().toISOString(), email.prospect_id], 'run');
            return { status: 'invalid', email_id: email.id, prospect_id: email.prospect_id };
          }
        } catch (verifyErr) {
          logger.warn(`[outreach] Verification error for ${email.to_email}: ${verifyErr.message} — sending anyway`);
        }

        // Generate HTML with tracking
        let htmlContent = wrapWithCTA(
          email.body.replace(/Book a 10-min demo:.*$/m, '').trim(),
          'Book a 10-min Demo',
          config.outreach.bookingLink,
          '',
          { unsubscribeEmail: email.from_email }
        );
        // Add link tracking and open pixel
        htmlContent = wrapLinksWithTracking(htmlContent, email.id);
        htmlContent += generateTrackingPixel(email.id);

        await transport.sendMail({
          from: `"${config.outreach.senderName}" <${sanitizeHeader(email.from_email)}>`,
          to: sanitizeHeader(email.to_email),
          subject: sanitizeHeader(email.subject),
          text: email.body,
          html: htmlContent,
          headers: {
            'List-Unsubscribe': `<mailto:${sanitizeHeader(email.from_email)}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        const sentNow = new Date().toISOString();
        await db.query(
          "UPDATE emails_sent SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?",
          [sentNow, sentNow, email.id],
          'run'
        );

        // Schedule Day 3 no-reply follow-up
        try {
          const { enqueueJob } = require('../utils/jobQueue');
          enqueueJob(db, 'noreply_followup', {
            prospect_id: email.prospect_id,
            to_email: email.to_email,
            from_email: email.from_email,
            original_subject: email.subject,
            campaign_id: campaignId,
            booking_link: config.outreach.bookingLink,
            sender_name: config.outreach.senderName,
            day: 3,
          }, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
        } catch (err) {
          logger.error('[outreach] Failed to schedule follow-up:', err.message);
        }

        try { logDataMutation(db, { action: 'email_sent', table: 'emails_sent', recordId: email.id, newValues: { status: 'sent', to_email: email.to_email } }); } catch (_) {}

        return { status: 'sent', email_id: email.id, prospect_id: email.prospect_id };
      } catch (err) {
        logger.error(`[outreach] Failed to send to ${email.to_email}:`, err.message);

        // Detect bounces
        const isBounce = err.responseCode >= 550 || err.message.includes('rejected') ||
          err.message.includes('not exist') || err.message.includes('undeliverable');

        const status = isBounce ? 'bounced' : 'failed';
        const now = new Date().toISOString();

        await db.query(
          "UPDATE emails_sent SET status = ?, error = ?, updated_at = ? WHERE id = ?",
          [status, err.message, now, email.id],
          'run'
        );

        // Mark bounced prospects so we never email them again
        if (isBounce) {
          await db.query("UPDATE prospects SET status = 'bounced', updated_at = ? WHERE id = ?", [now, email.prospect_id], 'run');
        }

        return { status: status, email_id: email.id, prospect_id: email.prospect_id, error: err.message };
      }
    };

    // Process emails in batches with concurrent sending
    for (let i = 0; i < drafts.length; i += BATCH_SIZE) {
      const batch = drafts.slice(i, i + BATCH_SIZE);
      logger.info(`[outreach] Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} emails)`);

      // Send all emails in batch concurrently
      const results = await Promise.allSettled(
        batch.map(email => sendEmailAsync(email))
      );

      // Process results and track successes/failures
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const outcome = result.value;
          if (outcome.status === 'sent') {
            sent++;
          } else if (outcome.status === 'invalid') {
            skippedInvalid++;
          } else if (outcome.status === 'bounced' || outcome.status === 'failed') {
            failed++;
          }
        } else {
          // Promise rejected (shouldn't happen due to try-catch in sendEmailAsync)
          logger.error('[outreach] Unexpected error in batch processing:', result.reason);
          failed++;
        }
      }

      // Rate limit pause between batches to avoid SMTP rate limits
      if (i + BATCH_SIZE < drafts.length) {
        logger.info(`[outreach] Batch complete. Pausing ${BATCH_DELAY_MS}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Update campaign status
    await db.query(
      "UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?",
      [new Date().toISOString(), campaignId],
      'run'
    );

    logger.info(`[outreach] Campaign ${campaignId}: sent=${sent} failed=${failed} invalid=${skippedInvalid}`);
    res.json({ sent, failed, skipped_invalid: skippedInvalid, remaining: remaining - sent });
  } catch (err) {
    logger.error('[outreach] send error:', err);
    res.status(500).json({ error: 'Failed to send emails' });
  }
});

module.exports = router;
