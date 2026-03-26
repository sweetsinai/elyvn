const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getTransporter } = require('../utils/mailer');
const config = require('../utils/config');
const { logger } = require('../utils/logger');

const anthropic = new Anthropic();

// GET /replies
router.get('/replies', (req, res) => {
  try {
    const db = req.app.locals.db;

    const replies = db.prepare(`
      SELECT es.*, p.business_name, p.phone, p.website, c.name as campaign_name
      FROM emails_sent es
      JOIN prospects p ON p.id = es.prospect_id
      LEFT JOIN campaigns c ON c.id = es.campaign_id
      WHERE es.reply_text IS NOT NULL
      ORDER BY es.reply_at DESC
    `).all();

    res.json({ replies });
  } catch (err) {
    logger.error('[outreach] replies error:', err);
    res.status(500).json({ error: 'Failed to fetch replies' });
  }
});

// POST /replies/:emailId/classify
router.post('/replies/:emailId/classify', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { emailId } = req.params;

    const email = db.prepare('SELECT * FROM emails_sent WHERE id = ?').get(emailId);
    if (!email || !email.reply_text) {
      return res.status(404).json({ error: 'Email or reply not found' });
    }

    // Classify with Claude
    const resp = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Classify this email reply into exactly one category. Reply with JSON: {"classification": "INTERESTED" | "QUESTION" | "NOT_INTERESTED" | "UNSUBSCRIBE", "suggested_response": "brief response text"}

Original email subject: ${email.subject}
Original email: ${email.body}

Reply: ${email.reply_text}`
      }]
    });

    let classification = 'QUESTION';
    let suggestedResponse = '';

    try {
      const parsed = JSON.parse(resp.content[0]?.text || '{}');
      classification = parsed.classification || 'QUESTION';
      suggestedResponse = parsed.suggested_response || '';
    } catch (err) {
      const text = resp.content[0]?.text || '';
      if (text.includes('INTERESTED')) classification = 'INTERESTED';
      else if (text.includes('NOT_INTERESTED')) classification = 'NOT_INTERESTED';
      else if (text.includes('UNSUBSCRIBE')) classification = 'UNSUBSCRIBE';
    }

    // Update email record
    db.prepare(
      'UPDATE emails_sent SET reply_classification = ?, updated_at = ? WHERE id = ?'
    ).run(classification, new Date().toISOString(), emailId);

    // Update prospect status based on classification
    const statusMap = {
      'INTERESTED': 'interested',
      'QUESTION': 'engaged',
      'NOT_INTERESTED': 'not_interested',
      'UNSUBSCRIBE': 'unsubscribed'
    };

    const now = new Date().toISOString();
    const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(email.prospect_id);

    db.prepare(
      'UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?'
    ).run(statusMap[classification] || 'engaged', now, email.prospect_id);

    const BOOKING_LINK = config.outreach.bookingLink;
    const SENDER_NAME = config.outreach.senderName;

    // === INTERESTED: Full conversion sequence ===
    if (classification === 'INTERESTED') {
      // 0. Create a lead record so this prospect enters the lead pipeline
      try {
        const client = db.prepare('SELECT * FROM clients WHERE is_active = 1 LIMIT 1').get();
        if (client && prospect) {
          const existingLead = db.prepare(
            'SELECT id FROM leads WHERE client_id = ? AND (email = ? OR (phone IS NOT NULL AND phone = ?))'
          ).get(client.id, email.to_email, prospect.phone || '');
          if (!existingLead) {
            const leadId = randomUUID();
            db.prepare(`
              INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, prospect_id, last_contact, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'outreach', 7, 'qualified', ?, ?, ?, ?)
            `).run(leadId, client.id, prospect.business_name || '', prospect.phone || null, email.to_email, prospect.id, now, now, now);
            logger.info(`[outreach] Lead ${leadId} created from INTERESTED prospect ${prospect.id}`);
          } else {
            // Update existing lead score
            db.prepare("UPDATE leads SET score = MAX(score, 7), stage = 'qualified', updated_at = ? WHERE id = ?").run(now, existingLead.id);
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

        db.prepare(
          'UPDATE emails_sent SET auto_response_sent = 1, updated_at = ? WHERE id = ?'
        ).run(now, emailId);
      } catch (err) {
        logger.error('[outreach] INTERESTED auto-reply failed:', err.message);
      }

      // 2. Send SMS with booking link if prospect has phone
      if (prospect?.phone) {
        try {
          const { sendSMS } = require('../utils/sms');
          const smsText = `Hi! This is ${SENDER_NAME} from ELYVN. Thanks for your interest! Book a quick 10-min demo here: ${BOOKING_LINK}`;
          await sendSMS(db, prospect.phone, smsText, null);
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
    res.status(500).json({ error: 'Failed to classify reply' });
  }
});

// POST /auto-classify — automatically classify all unclassified replies
// Call this on a cron (every 5 min) or after IMAP fetch
// Delegates to shared utility to avoid duplication and HTTP overhead
router.post('/auto-classify', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { autoClassifyReplies } = require('../utils/autoClassify');
    const result = await autoClassifyReplies(db);
    res.json({ classified: result.classified, results: result.results, message: result.message });
  } catch (err) {
    logger.error('[outreach] auto-classify error:', err);
    res.status(500).json({ error: 'Failed to auto-classify replies' });
  }
});

module.exports = router;
