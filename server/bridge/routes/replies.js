const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getTransporter } = require('../utils/mailer');
const config = require('../utils/config');
const { logger } = require('../utils/logger');
const { appendEvent, Events } = require('../utils/eventStore');
const { validateParams } = require('../middleware/validateRequest');
const { ReplyEmailParamsSchema } = require('../utils/schemas/replies');
const { AppError } = require('../utils/AppError');

const anthropic = new Anthropic();

// GET /replies
router.get('/replies', async (req, res) => {
  try {
    const db = req.app.locals.db;

    const clientFilter = req.isAdmin ? '' : 'AND es.client_id = ?';
    const clientParams = req.isAdmin ? [] : [req.clientId];

    const replies = await db.query(`
      SELECT es.*, p.business_name, p.phone, p.website, c.name as campaign_name
      FROM emails_sent es
      JOIN prospects p ON p.id = es.prospect_id
      LEFT JOIN campaigns c ON c.id = es.campaign_id
      WHERE es.reply_text IS NOT NULL ${clientFilter}
      ORDER BY es.reply_at DESC
    `, [...clientParams], 'all');

    res.json({ replies });
  } catch (err) {
    logger.error('[outreach] replies error:', err);
    res.status(500).json({ error: 'Failed to fetch replies' });
  }
});

// POST /replies/:emailId/classify
router.post('/replies/:emailId/classify', validateParams(ReplyEmailParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { emailId } = req.params;

    const email = await db.query('SELECT * FROM emails_sent WHERE id = ?', [emailId], 'get');
    if (!email || !email.reply_text) {
      return res.status(404).json({ error: 'Email or reply not found' });
    }

    // Idempotency: skip if already classified
    if (email.reply_classification) {
      return res.json({
        classification: email.reply_classification,
        suggested_response: '',
        skipped: true,
        reason: 'already_classified',
      });
    }

    // Classify with Claude
    const resp = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Classify this email reply into exactly one category. Reply with JSON: {"classification": "INTERESTED" | "QUESTION" | "NOT_INTERESTED" | "UNSUBSCRIBE", "confidence": 0.0-1.0, "suggested_response": "brief response text"}

confidence: how certain you are in this classification (0.0 = no idea, 1.0 = absolutely certain).

Original email subject: ${email.subject}
Original email: ${email.body}

Reply: ${email.reply_text}`
      }]
    });

    let classification = 'QUESTION';
    let confidence = 0.5;
    let suggestedResponse = '';

    try {
      const parsed = JSON.parse(resp.content[0]?.text || '{}');
      classification = parsed.classification || 'QUESTION';
      confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      suggestedResponse = parsed.suggested_response || '';
    } catch (err) {
      const text = resp.content[0]?.text || '';
      if (text.includes('INTERESTED')) classification = 'INTERESTED';
      else if (text.includes('NOT_INTERESTED')) classification = 'NOT_INTERESTED';
      else if (text.includes('UNSUBSCRIBE')) classification = 'UNSUBSCRIBE';
      confidence = 0.5;
    }

    confidence = Math.max(0, Math.min(1, confidence));

    // Determine if this reply is attributable to a prior link click (within 7 days)
    const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const replyAttributedToClick = email.clicked_at &&
      (Date.now() - new Date(email.clicked_at).getTime()) <= ATTRIBUTION_WINDOW_MS ? 1 : 0;

    // Update email record
    await db.query(
      'UPDATE emails_sent SET reply_classification = ?, reply_attributed_to_click = ?, updated_at = ? WHERE id = ?',
      [classification, replyAttributedToClick, new Date().toISOString(), emailId],
      'run'
    );

    // Emit ReplyReceived event (fire-and-forget)
    try {
      appendEvent(db, emailId, 'email', Events.ReplyReceived, {
        classification,
        emailId,
        reply_attributed_to_click: replyAttributedToClick,
      });
    } catch (_) { /* non-fatal */ }

    // Confidence gate: if low confidence, mark as needs_review instead of auto-updating stage
    const CONFIDENCE_THRESHOLD = 0.7;

    const statusMap = {
      'INTERESTED': 'interested',
      'QUESTION': 'engaged',
      'NOT_INTERESTED': 'not_interested',
      'UNSUBSCRIBE': 'unsubscribed'
    };

    const now = new Date().toISOString();
    const prospect = await db.query('SELECT * FROM prospects WHERE id = ?', [email.prospect_id], 'get');

    if (confidence < CONFIDENCE_THRESHOLD) {
      // Low confidence: store classification as needs_review, don't update prospect stage
      logger.warn(`[outreach] Low confidence (${confidence.toFixed(2)}) for email ${emailId} classified as ${classification} — marking needs_review`);
      await db.query(
        'UPDATE emails_sent SET reply_classification = ?, updated_at = ? WHERE id = ?',
        ['needs_review', now, emailId],
        'run'
      );

      return res.json({ classification, confidence, needs_review: true, suggested_response: suggestedResponse });
    }

    // Update prospect status based on classification
    const oldStatus = prospect?.status;
    const newStatus = statusMap[classification] || 'engaged';

    await db.query(
      'UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?',
      [newStatus, now, email.prospect_id],
      'run'
    );

    // Emit LeadStageChanged if prospect status actually changed (fire-and-forget)
    if (oldStatus && oldStatus !== newStatus) {
      try {
        appendEvent(db, email.prospect_id, 'lead', Events.LeadStageChanged, {
          from: oldStatus,
          to: newStatus,
          trigger: 'reply_classification',
          emailId,
        });
      } catch (_) { /* non-fatal */ }
    }

    const BOOKING_LINK = config.outreach.bookingLink;
    const SENDER_NAME = config.outreach.senderName;

    // === INTERESTED: Full conversion sequence ===
    if (classification === 'INTERESTED') {
      // 0. Create a lead record so this prospect enters the lead pipeline
      try {
        const client = await db.query('SELECT * FROM clients WHERE is_active = 1 LIMIT 1', [], 'get');
        if (client && prospect) {
          const existingLead = await db.query(
            'SELECT id FROM leads WHERE client_id = ? AND (email = ? OR (phone IS NOT NULL AND phone = ?))',
            [client.id, email.to_email, prospect.phone || ''],
            'get'
          );
          if (!existingLead) {
            const leadId = randomUUID();
            await db.query(`
              INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, prospect_id, last_contact, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'outreach', 7, 'qualified', ?, ?, ?, ?)
            `, [leadId, client.id, prospect.business_name || '', prospect.phone || null, email.to_email, prospect.id, now, now, now], 'run');
            logger.info(`[outreach] Lead ${leadId} created from INTERESTED prospect ${prospect.id}`);
          } else {
            // Update existing lead score
            await db.query("UPDATE leads SET score = MAX(score, 7), stage = 'qualified', updated_at = ? WHERE id = ?", [now, existingLead.id], 'run');
          }
        }
      } catch (err) {
        logger.error('[outreach] Lead creation from INTERESTED failed:', err.message);
      }

      // 1. Send email with booking link immediately
      const interestedReply = `Hi${prospect?.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nGreat to hear from you! I'd love to show you how ELYVN can help you catch every call and book more appointments.\n\nHere's my calendar — pick any time that works for you:\n${BOOKING_LINK}\n\nIf you'd prefer, you can also call us directly and our AI will walk you through a live demo.\n\nLooking forward to chatting!\n\n${SENDER_NAME}\nELYVN`;

      try {
        const transport = getTransporter();
        await transport.sendMail({
          from: email.from_email,
          to: email.to_email,
          subject: `Re: ${email.subject}`,
          text: interestedReply,
        });
        logger.info(`[outreach] INTERESTED auto-reply sent to ${email.to_email} with booking link`);

        await db.query(
          'UPDATE emails_sent SET auto_response_sent = 1, updated_at = ? WHERE id = ?',
          [now, emailId],
          'run'
        );
      } catch (err) {
        logger.error('[outreach] INTERESTED auto-reply failed:', err.message);
      }

      // 2. Send SMS with booking link if prospect has phone
      if (prospect?.phone) {
        try {
          const { sendSMS } = require('../utils/sms');
          const smsText = `Hi! This is ${SENDER_NAME} from ELYVN. Thanks for your interest! Book a quick 10-min demo here: ${BOOKING_LINK}`;
          await sendSMS(prospect.phone, smsText, null, db, null);
          logger.info(`[outreach] INTERESTED SMS sent to ${prospect.phone}`);
        } catch (err) {
          logger.error('[outreach] INTERESTED SMS failed:', err.message);
        }
      }

      // 3. Notify owner via Telegram
      try {
        const { sendTelegramNotification } = require('../utils/telegram');
        const alertMsg = `🔥 *HOT LEAD* from cold outreach!\n\n*${prospect?.business_name || 'Unknown'}*\n📧 ${email.to_email}\n📱 ${prospect?.phone || 'No phone'}\n\nThey replied INTERESTED to: "${email.subject}"\n\nBooking link sent automatically. Reply: "${email.reply_text?.substring(0, 200) || ''}"`;
        await sendTelegramNotification(alertMsg);
      } catch (err) {
        logger.error('[outreach] Telegram notification failed:', err.message);
      }

      // 4. Schedule follow-up email in 24h if no booking
      try {
        const { enqueueJob } = require('../utils/jobQueue');
        enqueueJob(db, 'interested_followup_email', {
          prospect_id: email.prospect_id,
          email_id: emailId,
          to_email: email.to_email,
          from_email: email.from_email,
          subject: email.subject,
          booking_link: BOOKING_LINK,
          sender_name: SENDER_NAME,
        }, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
        logger.info(`[outreach] Scheduled 24h follow-up for ${email.to_email}`);
      } catch (err) {
        logger.error('[outreach] Failed to schedule follow-up:', err.message);
      }

      suggestedResponse = interestedReply;
    }

    // === QUESTION: Send helpful response with booking link ===
    if (classification === 'QUESTION' && suggestedResponse) {
      // Append booking link to questions too
      suggestedResponse += `\n\nIf you'd like to see it in action, here's a quick demo link: ${BOOKING_LINK}`;

      try {
        const transport = getTransporter();
        await transport.sendMail({
          from: email.from_email,
          to: email.to_email,
          subject: `Re: ${email.subject}`,
          text: suggestedResponse,
        });
        logger.info(`[outreach] QUESTION auto-reply sent to ${email.to_email}`);
      } catch (err) {
        logger.error('[outreach] QUESTION auto-reply failed:', err.message);
      }
    }

    // === UNSUBSCRIBE: Confirm removal ===
    if (classification === 'UNSUBSCRIBE') {
      suggestedResponse = 'Thank you for letting us know. You have been removed from our list. We wish you all the best.';

      try {
        const transport = getTransporter();
        await transport.sendMail({
          from: email.from_email,
          to: email.to_email,
          subject: `Re: ${email.subject}`,
          text: suggestedResponse,
        });
        logger.info(`[outreach] UNSUBSCRIBE confirmed to ${email.to_email}`);
      } catch (err) {
        logger.error('[outreach] UNSUBSCRIBE auto-reply failed:', err.message);
      }
    }

    res.json({ classification, suggested_response: suggestedResponse });
  } catch (err) {
    logger.error('[outreach] classify error:', err);
    next(err);
  }
});

// POST /auto-classify — admin/cron only: classify all unclassified replies across all clients
// Guard against AI cost amplification: only service-level callers (ELYVN_API_KEY with isAdmin)
router.post('/auto-classify', async (req, res, next) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const db = req.app.locals.db;
    const { autoClassifyReplies } = require('../utils/autoClassify');
    const result = await autoClassifyReplies(db);
    res.json({ classified: result.classified, results: result.results, message: result.message });
  } catch (err) {
    logger.error('[outreach] auto-classify error:', err);
    next(err);
  }
});

module.exports = router;
