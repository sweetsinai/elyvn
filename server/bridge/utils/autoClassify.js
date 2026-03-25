const Anthropic = require('@anthropic-ai/sdk');
const { randomUUID } = require('crypto');
const { getTransporter } = require('./mailer');
const config = require('./config');

const anthropic = new Anthropic();

/**
 * Auto-classify unclassified email replies
 * Extracts business logic so it can be called directly from index.js without HTTP overhead
 * @param {Database} db - SQLite database instance
 * @returns {Promise<Object>} Classification results
 */
async function autoClassifyReplies(db) {
  try {
    const unclassified = db.prepare(`
      SELECT * FROM emails_sent
      WHERE reply_text IS NOT NULL AND reply_classification IS NULL
      ORDER BY reply_at ASC
      LIMIT 20
    `).all();

    if (!unclassified.length) {
      return { classified: 0, message: 'No unclassified replies', results: [] };
    }

    const results = [];
    for (const email of unclassified) {
      try {
        // Use Claude to classify the reply
        const MODEL = config.ai.model;
        const resp = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Classify this email reply into exactly one category. Reply with JSON only: {"classification": "INTERESTED" | "QUESTION" | "NOT_INTERESTED" | "UNSUBSCRIBE", "suggested_response": "brief response text"}

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
          console.error('[autoClassify] JSON parse failed, using fallback classification:', err.message);
          const text = resp.content[0]?.text || '';
          if (text.includes('INTERESTED')) classification = 'INTERESTED';
          else if (text.includes('NOT_INTERESTED')) classification = 'NOT_INTERESTED';
          else if (text.includes('UNSUBSCRIBE')) classification = 'UNSUBSCRIBE';
        }

        const now = new Date().toISOString();

        // Update classification
        db.prepare(
          'UPDATE emails_sent SET reply_classification = ?, updated_at = ? WHERE id = ?'
        ).run(classification, now, email.id);

        // Update prospect status
        const statusMap = {
          'INTERESTED': 'interested',
          'QUESTION': 'engaged',
          'NOT_INTERESTED': 'not_interested',
          'UNSUBSCRIBE': 'unsubscribed'
        };
        db.prepare(
          'UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?'
        ).run(statusMap[classification] || 'engaged', now, email.prospect_id);

        const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(email.prospect_id);
        const BOOKING_LINK = config.outreach.bookingLink;
        const SENDER_NAME = config.outreach.senderName;

        // Auto-respond based on classification
        if (classification === 'INTERESTED' && !email.auto_response_sent) {
          // Create lead from interested prospect
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
                console.log(`[autoClassify] Lead created from INTERESTED prospect ${prospect.id}`);
              } else {
                db.prepare("UPDATE leads SET score = MAX(score, 7), stage = 'qualified', updated_at = ? WHERE id = ?").run(now, existingLead.id);
              }
            }
          } catch (err) {
            console.error('[autoClassify] Lead creation failed:', err.message);
          }

          const interestedReply = `Hi${prospect?.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nGreat to hear from you! I'd love to show you how ELYVN can help.\n\nPick any time: ${BOOKING_LINK}\n\nLooking forward to chatting!\n\n${SENDER_NAME}\nELYVN`;
          try {
            const transport = getTransporter();
            await transport.sendMail({
              from: email.from_email,
              to: email.to_email,
              subject: `Re: ${email.subject}`,
              text: interestedReply,
            });
            db.prepare('UPDATE emails_sent SET auto_response_sent = 1, updated_at = ? WHERE id = ?').run(now, email.id);

            // SMS if phone available
            if (prospect?.phone) {
              try {
                const { sendSMS } = require('./sms');
                await sendSMS(prospect.phone, `Hi! This is ${SENDER_NAME} from ELYVN. Thanks for your interest! Book a demo: ${BOOKING_LINK}`, null);
              } catch (err) {
                console.error('[autoClassify] SMS send failed:', err.message);
              }
            }

            // Telegram alert
            try {
              const { sendTelegramNotification } = require('./telegram');
              await sendTelegramNotification(`🔥 *HOT LEAD* (auto-classified)\n*${prospect?.business_name || 'Unknown'}* — ${email.to_email}\nReplied INTERESTED. Auto-response sent.`);
            } catch (err) {
              console.error('[autoClassify] Telegram notification failed:', err.message);
            }

            // 24h follow-up job
            try {
              const { enqueueJob } = require('./jobQueue');
              enqueueJob(db, 'interested_followup_email', {
                prospect_id: email.prospect_id,
                email_id: email.id,
                to_email: email.to_email,
                from_email: email.from_email,
                subject: email.subject,
                booking_link: BOOKING_LINK,
                sender_name: SENDER_NAME,
              }, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
            } catch (err) {
              console.error('[autoClassify] Job enqueue failed:', err.message);
            }
          } catch (err) {
            console.error('[autoClassify] INTERESTED auto-reply failed:', err.message);
          }
        }

        if (classification === 'UNSUBSCRIBE') {
          try {
            const transport = getTransporter();
            await transport.sendMail({
              from: email.from_email,
              to: email.to_email,
              subject: `Re: ${email.subject}`,
              text: 'You have been removed from our list. We wish you all the best.',
            });
          } catch (err) {
            console.error('[autoClassify] Unsubscribe confirmation email failed:', err.message);
          }
        }

        results.push({ id: email.id, to: email.to_email, classification });
        console.log(`[autoClassify] ${email.to_email} → ${classification}`);

        // Small delay between API calls
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`[autoClassify] Failed for ${email.id}:`, err.message);
        results.push({ id: email.id, error: err.message });
      }
    }

    return { classified: results.filter(r => !r.error).length, results };
  } catch (err) {
    console.error('[autoClassify] Error:', err.message);
    throw err;
  }
}

module.exports = { autoClassifyReplies };
