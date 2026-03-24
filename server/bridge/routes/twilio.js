const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { sendSMS } = require('../utils/sms');
const telegram = require('../utils/telegram');
const { cancelBooking } = require('../utils/calcom');
const fs = require('fs');
const path = require('path');

const anthropic = new Anthropic();

// POST / — Twilio SMS webhook
router.post('/', (req, res) => {
  const { From, To, Body, MessageSid } = req.body || {};

  // Respond with empty TwiML immediately
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  const db = req.app.locals.db;
  if (!db) {
    console.error('[twilio] No database connection');
    return;
  }

  if (!From || !To) {
    console.warn('[twilio] Missing From or To in SMS webhook');
    return;
  }

  // Process async
  setImmediate(() => {
    try {
      handleInboundSMS(db, { from: From, to: To, body: Body, messageSid: MessageSid });
    } catch (err) {
      console.error('[twilio] setImmediate error:', err);
    }
  });
});

async function handleInboundSMS(db, { from, to, body, messageSid }) {
  try {
    console.log(`[twilio] SMS from ${from} to ${to} (${(body || '').length} chars)`);

    // Idempotency: skip if this MessageSid was already processed (webhook retry)
    if (messageSid) {
      const dup = db.prepare('SELECT id FROM messages WHERE message_sid = ?').get(messageSid);
      if (dup) {
        console.log(`[twilio] Duplicate MessageSid ${messageSid}, skipping`);
        return;
      }
    }

    // Identify client by matching To number
    const client = db.prepare(
      'SELECT * FROM clients WHERE twilio_phone = ? OR retell_phone = ?'
    ).get(to, to);

    if (!client) {
      console.error(`[twilio] No client found for number ${to}`);
      return;
    }

    const trimmed = (body || '').toUpperCase().trim();

    if (trimmed === 'CANCEL') {
      await handleCancel(db, client, from, to);
    } else if (trimmed === 'YES') {
      await handleYes(db, client, from, to);
    } else {
      await handleNormalMessage(db, client, from, to, body, messageSid);
    }
  } catch (err) {
    console.error('[twilio] handleInboundSMS error:', err);
  }
}

async function handleCancel(db, client, from, replyFrom) {
  try {
    // Find most recent booking for this phone via leads table
    const lead = db.prepare(
      'SELECT calcom_booking_id FROM leads WHERE phone = ? AND client_id = ? AND calcom_booking_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1'
    ).get(from, client.id);

    if (!lead?.calcom_booking_id) {
      await sendSMS(from, 'No upcoming appointment found to cancel.', replyFrom);
      return;
    }

    const result = await cancelBooking(lead.calcom_booking_id);

    if (result.success) {
      // Update lead stage
      db.prepare(
        'UPDATE leads SET calcom_booking_id = NULL, stage = \'contacted\', updated_at = ? WHERE phone = ? AND client_id = ?'
      ).run(new Date().toISOString(), from, client.id);

      await sendSMS(from, 'Your appointment has been cancelled.', replyFrom);
      console.log(`[twilio] Booking ${lead.calcom_booking_id} cancelled for ${from}`);
    } else {
      await sendSMS(from, 'Sorry, we couldn\'t cancel your appointment right now. Please call us directly.', replyFrom);
    }
  } catch (err) {
    console.error('[twilio] handleCancel error:', err);
    await sendSMS(from, 'Sorry, something went wrong. Please call us directly.', replyFrom).catch(() => {});
  }
}

async function handleYes(db, client, from, replyFrom) {
  try {
    const bookingLink = client.calcom_booking_link;

    if (bookingLink) {
      await sendSMS(from, `Book your appointment here: ${bookingLink}`, replyFrom);
    } else {
      await sendSMS(from, 'Please call us to schedule your appointment.', replyFrom);
    }
  } catch (err) {
    console.error('[twilio] handleYes error:', err);
  }
}

async function handleNormalMessage(db, client, from, to, body, messageSid) {
  try {
    // Check if AI is paused — log message but do not auto-reply
    if (!client.is_active) {
      console.log(`[twilio] AI paused for client ${client.id} — logging message from ${from} without reply`);
      // Upsert lead so the message is tracked
      const existingLead = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(from, client.id);
      let leadId;
      if (existingLead) {
        leadId = existingLead.id;
      } else {
        leadId = randomUUID();
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, 'new', ?, ?, ?)
        `).run(leadId, client.id, from, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      }
      // Log inbound message
      db.prepare(`
        INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, created_at)
        VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, datetime('now'))
      `).run(randomUUID(), client.id, leadId, from, body, messageSid || null);
      // Notify owner via Telegram
      if (client.telegram_chat_id) {
        const tg = require('../utils/telegram');
        tg.sendMessage(
          client.telegram_chat_id,
          `⏸ <b>AI paused</b> — message received (no auto-reply)\n\nFrom: ${from}\nMessage: "${(body || '').substring(0, 200)}"`
        ).catch(() => {});
      }
      return;
    }

    // Rate limit: don't auto-reply if we already replied to this number in the last 5 minutes
    const recentOutbound = db.prepare(
      "SELECT COUNT(*) as c FROM messages WHERE phone = ? AND direction = 'outbound' AND created_at >= datetime('now','-5 minutes')"
    ).get(from);
    if (recentOutbound.c > 0) {
      console.log(`[twilio] Rate limited outbound to ${from} — already replied within 5 min`);
      // Still log the inbound message
      const existingLead2 = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(from, client.id);
      if (existingLead2) {
        db.prepare(`
          INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, created_at)
          VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, datetime('now'))
        `).run(randomUUID(), client.id, existingLead2.id, from, body, messageSid || null);
      }
      return;
    }

    // Load client knowledge base
    let kb = '';
    const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${client.id}.json`);
    try {
      const kbData = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
      kb = typeof kbData === 'string' ? kbData : JSON.stringify(kbData, null, 2);
      if (kb.length > 5000) kb = kb.substring(0, 5000) + '\n[...truncated]';
    } catch (_) {
      console.log(`[twilio] No KB found for client ${client.id}`);
    }

    // Claude generates reply based on KB
    let reply = '';
    let confidence = 'medium';

    try {
      const resp = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: `You are a helpful SMS assistant for ${client.business_name || 'our business'}. Answer the customer's question using ONLY the following knowledge base information. Do not make up information not found in the knowledge base.

Knowledge Base:
${kb || 'No knowledge base available.'}

Reply in JSON format: {"reply": "your reply text (keep under 160 chars for SMS)", "confidence": "high" | "medium" | "low"}
If you cannot answer from the knowledge base, set confidence to "low".`,
        messages: [{ role: 'user', content: body }]
      });

      const rawText = resp.content[0]?.text || '';
      try {
        const parsed = JSON.parse(rawText);
        reply = parsed.reply || rawText;
        confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'high';
      } catch (_) {
        reply = rawText;
        confidence = 'high';
      }
    } catch (err) {
      console.error('[twilio] Claude reply generation failed:', err.message);
      reply = 'Thanks for your message! We\'ll get back to you shortly.';
      confidence = 'low';
    }

    // Low confidence: send generic reply + notify owner
    if (confidence === 'low') {
      reply = 'Great question! Let me check with the team and get back to you shortly.';

      if (client.owner_phone) {
        sendSMS(
          client.owner_phone,
          `[ELYVN] Question from ${from} that needs your input:\n"${body}"`
        ).catch(err => console.error('[twilio] Owner notification failed:', err.message));
      }
    }

    // Upsert lead
    const existingLead = db.prepare(
      'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
    ).get(from, client.id);

    let leadId;
    if (existingLead) {
      leadId = existingLead.id;
      db.prepare('UPDATE leads SET last_contact = ?, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), new Date().toISOString(), leadId);
    } else {
      leadId = randomUUID();
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, stage, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, 'new', ?, ?, ?)
      `).run(leadId, client.id, from, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    }

    // Insert inbound + outbound messages in a transaction
    const inboundId = randomUUID();
    const outboundId = randomUUID();

    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, confidence, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, ?, datetime('now'))
    `).run(inboundId, client.id, leadId, from, body, messageSid || null, confidence);

    // Send reply via Twilio REST API
    await sendSMS(from, reply, to);

    // Record outbound message
    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, confidence, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'auto_replied', ?, datetime('now'))
    `).run(outboundId, client.id, leadId, from, reply, confidence);

    // Schedule follow-up touch for brand-new SMS contacts
    if (!existingLead) {
      try {
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
          VALUES (?, ?, ?, 2, 'nudge', NULL, 'pending', ?, 'scheduled')
        `).run(randomUUID(), leadId, client.id, tomorrow);
      } catch (fuErr) {
        console.error('[twilio] Follow-up scheduling error:', fuErr.message);
      }
    }

    // === Telegram notification ===
    try {
      const clientForNotify = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
      if (clientForNotify && clientForNotify.telegram_chat_id) {
        if (confidence === 'low') {
          const { text, buttons } = telegram.formatEscalation(
            { phone: from, body, id: messageSid || randomUUID() },
            reply,
            clientForNotify
          );
          telegram.sendMessage(clientForNotify.telegram_chat_id, text, { reply_markup: { inline_keyboard: buttons } });
        } else {
          const { text, buttons } = telegram.formatMessageNotification(
            { phone: from, body, id: messageSid || randomUUID() },
            reply,
            confidence,
            clientForNotify
          );
          telegram.sendMessage(clientForNotify.telegram_chat_id, text, { reply_markup: { inline_keyboard: buttons } });
        }
      }
    } catch (tgErr) {
      console.error('[twilio] Telegram notification failed:', tgErr.message);
    }

    console.log(`[twilio] Replied to ${from}: ${reply.substring(0, 50)}...`);

    // === BRAIN — autonomous post-SMS decisions ===
    try {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');

      const memory = getLeadMemory(db, from, client.id);
      if (memory) {
        const decision = await think('sms_received', {
          from, body, auto_reply: reply, confidence,
          was_escalated: confidence === 'low',
        }, memory, db);
        await executeActions(db, decision.actions, memory);
      }
    } catch (brainErr) {
      console.error('[Brain] Post-SMS error:', brainErr.message);
    }
  } catch (err) {
    console.error('[twilio] handleNormalMessage error:', err);
  }
}

module.exports = router;
