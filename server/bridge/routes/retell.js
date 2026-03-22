const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { sendSMS, sendSMSToOwner } = require('../utils/sms');
const telegram = require('../utils/telegram');

const anthropic = new Anthropic();
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_BASE = 'https://api.retellai.com/v2';

// POST / — handles all Retell webhook events
router.post('/', (req, res) => {
  const { event, call } = req.body;

  // Always respond 200 immediately
  res.status(200).json({ received: true });

  const db = req.app.locals.db;
  if (!db) {
    console.error('[retell] No database connection');
    return;
  }

  // Process async
  setImmediate(() => {
    try {
      switch (event) {
        case 'call_started':
          handleCallStarted(db, call);
          break;
        case 'call_ended':
          handleCallEnded(db, call);
          break;
        case 'call_analyzed':
          handleCallAnalyzed(db, call);
          break;
        case 'agent_transfer':
        case 'transfer_requested':
          handleTransfer(db, call);
          break;
        case 'dtmf':
          if (call.digit === '*') handleTransfer(db, call);
          break;
        default:
          console.log(`[retell] Unhandled event: ${event}`);
      }
    } catch (err) {
      console.error(`[retell] Error processing ${event}:`, err);
    }
  });
});

function handleCallStarted(db, call) {
  try {
    const callId = call.call_id;
    const toNumber = call.to_number;
    const callerPhone = call.from_number;
    const direction = call.direction || 'inbound';

    // Match client by retell phone number
    const client = db.prepare(
      `SELECT id FROM clients WHERE retell_phone = ? OR twilio_phone = ?`
    ).get(toNumber, toNumber);

    const clientId = client?.id || null;

    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), callId, clientId, callerPhone, direction, new Date().toISOString());

    console.log(`[retell] call_started: ${callId} client=${clientId} from=${callerPhone}`);
  } catch (err) {
    console.error('[retell] call_started error:', err);
  }
}

async function handleCallEnded(db, call) {
  try {
    const callId = call.call_id;
    console.log(`[retell] call_ended: ${callId}`);

    // 1. Fetch full call data from Retell
    const retellResp = await fetch(`${RETELL_BASE}/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` }
    });

    if (!retellResp.ok) {
      console.error(`[retell] Failed to fetch call ${callId}: ${retellResp.status}`);
      return;
    }

    const callData = await retellResp.json();
    const transcript = callData.transcript || '';
    const duration = callData.call_length || call.duration || 0;
    const callAnalysis = callData.call_analysis || {};
    const customAnalysis = callData.custom_analysis_data || {};

    // 2. Get existing call record
    const callRecord = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
    if (!callRecord) {
      console.error(`[retell] No call record found for ${callId}`);
      return;
    }

    const transcriptText = typeof transcript === 'string'
      ? transcript
      : Array.isArray(transcript)
        ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
        : JSON.stringify(transcript);

    // 3. Generate summary from transcript
    let summary = '';
    try {
      const summaryResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{ role: 'user', content: `Summarize this phone call transcript in exactly 2 lines. Be specific about what was discussed and any outcomes:\n\n${transcriptText}` }]
      });
      summary = summaryResp.content[0]?.text || '';
    } catch (err) {
      console.error('[retell] Summary generation failed:', err.message);
      summary = 'Summary unavailable';
    }

    // 4. Score lead 1-10
    let score = 5;
    try {
      const scoreResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [{ role: 'user', content: `Score this lead 1-10 based on their interest, urgency, and qualification from this call transcript. Reply with ONLY a single number:\n\n${transcriptText}` }]
      });
      const parsed = parseInt(scoreResp.content[0]?.text?.trim(), 10);
      if (parsed >= 1 && parsed <= 10) score = parsed;
    } catch (err) {
      console.error('[retell] Lead scoring failed:', err.message);
    }

    // 5. Determine outcome
    let outcome = 'info_provided';
    const analysisOutcome = callAnalysis.call_successful;
    const bookingId = customAnalysis.calcom_booking_id || callData.metadata?.calcom_booking_id;

    if (bookingId) {
      outcome = 'booked';
    } else if (callAnalysis.agent_transfer || customAnalysis.transferred) {
      outcome = 'transferred';
    } else if (duration < 10) {
      outcome = 'missed';
    } else if (callAnalysis.voicemail_detected) {
      outcome = 'voicemail';
    }

    const sentiment = callAnalysis.user_sentiment || 'neutral';

    // 6. Update call record
    db.prepare(`
      UPDATE calls SET
        duration = ?,
        outcome = ?,
        summary = ?,
        score = ?,
        sentiment = ?,
        transcript = ?,
        updated_at = ?
      WHERE call_id = ?
    `).run(duration, outcome, summary, score, sentiment, transcriptText, new Date().toISOString(), callId);

    // 7. Upsert lead
    const callerPhone = callRecord.caller_phone;
    const clientId = callRecord.client_id;

    if (callerPhone && clientId) {
      const existingLead = db.prepare(
        'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
      ).get(callerPhone, clientId);

      if (existingLead) {
        db.prepare(`
          UPDATE leads SET
            score = ?,
            last_contact = ?,
            stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END,
            updated_at = ?
          WHERE id = ?
        `).run(score, new Date().toISOString(), new Date().toISOString(), existingLead.id);
      } else {
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, score, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'new', ?, ?, ?)
        `).run(randomUUID(), clientId, callerPhone, score, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      }

      // 8. Store booking reference
      if (bookingId) {
        const lead = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(callerPhone, clientId);
        if (lead) {
          db.prepare(`
            UPDATE leads SET calcom_booking_id = ?, stage = 'booked', updated_at = ? WHERE id = ?
          `).run(bookingId, new Date().toISOString(), lead.id);
        }
      }

      // 9. Schedule follow-up SMS sequence
      if (outcome !== 'missed' && outcome !== 'voicemail') {
        scheduleFollowUp(db, clientId, callerPhone, outcome);
      }

      // 9b. Missed call — instant text-back + speed-to-lead sequence
      if (outcome === 'missed') {
        try {
          const missedClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
          if (missedClient) {
            const missedLead = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(callerPhone, clientId);
            const missedLeadId = missedLead?.id || randomUUID();
            if (!missedLead) {
              db.prepare(`
                INSERT INTO leads (id, client_id, phone, source, score, stage, last_contact, created_at, updated_at)
                VALUES (?, ?, ?, 'missed_call', 5, 'new', datetime('now'), datetime('now'), datetime('now'))
              `).run(missedLeadId, clientId, callerPhone);
            }
            const { triggerSpeedSequence } = require('../utils/speed-to-lead');
            triggerSpeedSequence(db, {
              leadId: missedLeadId,
              clientId,
              phone: callerPhone,
              name: null,
              email: null,
              message: null,
              service: null,
              source: 'missed_call',
              client: missedClient
            }).catch(err => console.error('[retell] Missed call speed sequence failed:', err.message));
          }
        } catch (missedErr) {
          console.error('[retell] Missed call handler error:', missedErr.message);
        }
      }

      // 10. Notify owner on transfer or complaint
      const isComplaint = sentiment === 'negative' || (summary && summary.toLowerCase().includes('complaint'));
      if (outcome === 'transferred' || isComplaint) {
        const client = db.prepare('SELECT owner_phone, business_name FROM clients WHERE id = ?').get(clientId);
        if (client?.owner_phone) {
          const reason = outcome === 'transferred' ? 'Transfer' : 'Complaint detected';
          sendSMS(
            client.owner_phone,
            `[ELYVN] ${reason} — ${client.business_name}\nCaller: ${callerPhone}\n${summary}`
          ).catch(err => console.error('[retell] Owner SMS failed:', err.message));
        }
      }
    }

    // === Telegram notification ===
    try {
      const clientForNotify = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
      if (clientForNotify && clientForNotify.telegram_chat_id) {
        const processedCall = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
        if (processedCall) {
          if (outcome === 'transferred') {
            const { text } = telegram.formatTransferAlert(processedCall, summary, clientForNotify);
            telegram.sendMessage(clientForNotify.telegram_chat_id, text);
          } else {
            const { text, buttons } = telegram.formatCallNotification(processedCall, clientForNotify);
            telegram.sendMessage(clientForNotify.telegram_chat_id, text, { inline_keyboard: buttons });
          }
        }
      }
    } catch (tgErr) {
      console.error('[retell] Telegram notification failed:', tgErr.message);
    }

    console.log(`[retell] call_ended processed: ${callId} outcome=${outcome} score=${score}`);
  } catch (err) {
    console.error('[retell] call_ended error:', err);
  }
}

function handleCallAnalyzed(db, call) {
  try {
    const callId = call.call_id;
    const analysis = call.call_analysis || {};

    db.prepare(`
      UPDATE calls SET
        sentiment = COALESCE(?, sentiment),
        analysis_data = ?,
        updated_at = ?
      WHERE call_id = ?
    `).run(
      analysis.user_sentiment || null,
      JSON.stringify(analysis),
      new Date().toISOString(),
      callId
    );

    console.log(`[retell] call_analyzed: ${callId}`);
  } catch (err) {
    console.error('[retell] call_analyzed error:', err);
  }
}

async function handleTransfer(db, call) {
  try {
    const callId = call.call_id;
    const callerPhone = call.from_number;
    console.log(`[retell] transfer: ${callId}`);

    // Fetch transcript
    const retellResp = await fetch(`${RETELL_BASE}/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` }
    });

    let summary = 'Transfer requested';
    if (retellResp.ok) {
      const callData = await retellResp.json();
      const transcript = callData.transcript || '';
      const transcriptText = typeof transcript === 'string'
        ? transcript
        : Array.isArray(transcript)
          ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
          : JSON.stringify(transcript);

      try {
        const summaryResp = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 100,
          messages: [{ role: 'user', content: `Summarize this call in 2 sentences for the business owner who is about to receive a transfer:\n\n${transcriptText}` }]
        });
        summary = summaryResp.content[0]?.text || summary;
      } catch (_) {}
    }

    // Update call outcome
    db.prepare(`
      UPDATE calls SET outcome = 'transferred', summary = ?, updated_at = ? WHERE call_id = ?
    `).run(summary, new Date().toISOString(), callId);

    // Find client and send SMS to owner
    const callRecord = db.prepare('SELECT client_id FROM calls WHERE call_id = ?').get(callId);
    if (callRecord?.client_id) {
      const client = db.prepare('SELECT owner_phone FROM clients WHERE id = ?').get(callRecord.client_id);
      if (client?.owner_phone) {
        await sendSMS(
          client.owner_phone,
          `Transfer incoming from ${callerPhone || 'unknown'} -- ${summary}`
        );
      }
    }

    // === Telegram transfer alert ===
    try {
      const tgClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(callRecord?.client_id);
      if (tgClient && tgClient.telegram_chat_id) {
        const { text } = telegram.formatTransferAlert(
          { caller_name: callerPhone, caller_phone: callerPhone },
          summary,
          tgClient
        );
        telegram.sendMessage(tgClient.telegram_chat_id, text);
      }
    } catch (tgErr) {
      console.error('[retell] Telegram transfer alert failed:', tgErr.message);
    }
  } catch (err) {
    console.error('[retell] transfer error:', err);
  }
}

function scheduleFollowUp(db, clientId, callerPhone, outcome) {
  try {
    // Find lead for this phone
    const lead = db.prepare(
      'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
    ).get(callerPhone, clientId);

    if (!lead) {
      console.log(`[retell] No lead found for ${callerPhone}, skipping follow-up`);
      return;
    }

    const leadId = lead.id;
    const now = new Date();

    const touches = outcome === 'booked'
      ? [
          { touchNumber: 1, type: 'confirmation', delayMs: 5 * 60 * 1000, content: 'Your appointment is confirmed! Reply CANCEL to cancel.' },
          { touchNumber: 2, type: 'reminder', delayMs: 24 * 60 * 60 * 1000, content: 'Reminder: your appointment is coming up soon!' }
        ]
      : [
          { touchNumber: 1, type: 'thank_you', delayMs: 2 * 60 * 60 * 1000, content: 'Thanks for calling! Book online anytime.' },
          { touchNumber: 2, type: 'nudge', delayMs: 48 * 60 * 60 * 1000, content: 'Still need service? We have availability this week.' }
        ];

    for (const touch of touches) {
      const scheduledAt = new Date(now.getTime() + touch.delayMs);
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'template', ?, 'scheduled')
      `).run(randomUUID(), leadId, clientId, touch.touchNumber, touch.type, touch.content, scheduledAt.toISOString());
    }

    console.log(`[retell] Scheduled ${touches.length} follow-ups for ${callerPhone}`);
  } catch (err) {
    console.error('[retell] scheduleFollowUp error:', err);
  }
}

module.exports = router;
