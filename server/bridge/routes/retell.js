const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { sendSMS, sendSMSToOwner } = require('../utils/sms');
const telegram = require('../utils/telegram');

const anthropic = new Anthropic();
const { normalizePhone } = require('../utils/phone');
const { CircuitBreaker } = require('../utils/resilience');
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_BASE = 'https://api.retellai.com/v2';

// Circuit breakers for external APIs
const retellBreaker = new CircuitBreaker(
  async (url, opts) => {
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`Retell API ${resp.status}`);
    return resp;
  },
  { failureThreshold: 3, failureWindow: 60000, cooldownPeriod: 30000, serviceName: 'Retell' }
);

// POST / — handles all Retell webhook events
router.post('/', (req, res) => {
  const body = req.body || {};
  const event = body.event;
  const call = body.call || {};

  // Always respond 200 immediately
  res.status(200).json({ received: true });

  if (!event) {
    console.log('[retell] No event in payload');
    return;
  }

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
          if (call && call.digit === '*') handleTransfer(db, call);
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
    if (!call || !call.call_id) {
      console.warn('[retell] call_started missing call or call_id');
      return;
    }
    const callId = call.call_id;
    const direction = call.direction || 'inbound';
    // For outbound calls, the customer is to_number; for inbound, it's from_number
    const callerPhone = direction === 'outbound'
      ? normalizePhone(call.to_number)
      : normalizePhone(call.from_number);
    const toNumber = call.to_number;

    // Match client by retell phone number; fall back to agent ID for web calls
    let client = db.prepare(
      `SELECT id FROM clients WHERE retell_phone = ? OR twilio_phone = ?`
    ).get(toNumber, toNumber);

    if (!client && call.agent_id) {
      client = db.prepare('SELECT id FROM clients WHERE retell_agent_id = ?').get(call.agent_id);
    }

    const clientId = client?.id || null;

    if (!clientId) {
      console.warn(`[retell] call_started: no matching client for ${callId} toNumber=${toNumber}`);
      return;
    }

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
    if (!call || !call.call_id) {
      console.warn('[retell] call_ended missing call or call_id');
      return;
    }
    const callId = call.call_id;
    console.log(`[retell] call_ended: ${callId}`);

    // Idempotency: skip if this call_ended was already processed (webhook retry)
    // Check outcome (not summary) because call_analyzed can set summary before call_ended arrives
    const alreadyProcessed = db.prepare(
      "SELECT id FROM calls WHERE call_id = ? AND outcome IS NOT NULL"
    ).get(callId);
    if (alreadyProcessed) {
      console.log(`[retell] call_ended: ${callId} already processed, skipping (idempotent)`);
      return;
    }

    // 1. Fetch full call data from Retell (fall back to webhook payload on failure)
    let callData = {};
    if (RETELL_API_KEY) {
      try {
        const retellResp = await fetch(`${RETELL_BASE}/get-call/${callId}`, {
          headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
          signal: AbortSignal.timeout(30000),
        });
        if (retellResp.ok) {
          callData = await retellResp.json();
        } else {
          console.warn(`[retell] Retell API fetch failed for ${callId} (${retellResp.status}), using webhook payload`);
        }
      } catch (fetchErr) {
        console.warn(`[retell] Retell API fetch error for ${callId}:`, fetchErr.message, '— using webhook payload');
      }
    } else {
      console.warn('[retell] No RETELL_API_KEY — using webhook payload data only');
    }

    const transcript = callData.transcript || '';
    const duration = callData.call_length || call.duration || call.call_length || 0;
    const callAnalysis = callData.call_analysis || call.call_analysis || {};
    const customAnalysis = callData.custom_analysis_data || call.custom_analysis_data || {};

    // 2. Get existing call record (or create one if call_started was missed)
    let callRecord = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
    if (!callRecord) {
      console.warn(`[retell] No call record for ${callId} — inserting from call_ended payload`);
      const toNumber = callData.to_number || call.to_number;
      const callDirection = callData.direction || call.direction || 'inbound';
      // For outbound calls, customer is to_number; for inbound, it's from_number
      const fromNumber = callDirection === 'outbound'
        ? normalizePhone(toNumber)
        : normalizePhone(callData.from_number || call.from_number);
      const agentId = callData.agent_id || call.agent_id;

      let client = null;
      if (toNumber) {
        client = db.prepare('SELECT id FROM clients WHERE retell_phone = ? OR twilio_phone = ?').get(toNumber, toNumber);
      }
      if (!client && agentId) {
        client = db.prepare('SELECT id FROM clients WHERE retell_agent_id = ?').get(agentId);
      }
      const insertedClientId = client?.id || null;

      if (!insertedClientId) {
        console.warn(`[retell] No matching client for call ${callId} — cannot insert (client_id NOT NULL)`);
        return;
      }

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), callId, insertedClientId, fromNumber || null, callData.direction || call.direction || 'inbound', new Date().toISOString());

      callRecord = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
      if (!callRecord) {
        console.error(`[retell] Failed to create call record for ${callId}`);
        return;
      }
    }

    const transcriptText = typeof transcript === 'string'
      ? transcript
      : Array.isArray(transcript)
        ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
        : JSON.stringify(transcript);

    // 3. Generate summary and score
    let summary = '';
    let score = 5;

    // Determine the best text source for summary + scoring
    const hasTranscript = transcriptText && transcriptText.trim().length >= 10;
    const analysisSummary = callAnalysis.call_summary || '';
    const scoringText = hasTranscript ? transcriptText : analysisSummary;

    if (duration <= 15 && !hasTranscript && !analysisSummary) {
      // Genuinely short call with no content
      summary = 'Call too short for summary';
    } else if (scoringText.length >= 10) {
      // We have text to work with (transcript or call_summary from webhook)
      try {
        const summaryResp = await anthropic.messages.create({
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
          max_tokens: 150,
          messages: [{ role: 'user', content: hasTranscript
            ? `Summarize this phone call transcript in exactly 2 lines. Be specific about what was discussed and any outcomes:\n\n${transcriptText}`
            : `Rewrite this call summary in 2 clear lines for a business owner:\n\n${analysisSummary}` }]
        });
        summary = summaryResp.content[0]?.text || analysisSummary;
      } catch (err) {
        console.error('[retell] Summary generation failed:', err.message);
        summary = analysisSummary || 'Summary unavailable';
      }

      // 4. Score lead 1-10
      try {
        const scoreResp = await anthropic.messages.create({
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
          max_tokens: 10,
          messages: [{ role: 'user', content: `Score this lead 1-10 based on their interest, urgency, and qualification from this call ${hasTranscript ? 'transcript' : 'summary'}. Reply with ONLY a single number:\n\n${scoringText}` }]
        });
        const parsed = parseInt(scoreResp.content[0]?.text?.trim(), 10);
        if (parsed >= 1 && parsed <= 10) score = parsed;
      } catch (err) {
        console.error('[retell] Lead scoring failed:', err.message);
      }
    } else {
      // No transcript, no analysis summary — use what we have
      summary = analysisSummary || 'Summary unavailable';
    }

    // 5. Determine outcome
    let outcome = 'info_provided';
    const bookingId = customAnalysis.calcom_booking_id || callData.metadata?.calcom_booking_id;
    const disconnectionReason = callData.disconnection_reason || call.disconnection_reason || '';

    if (bookingId) {
      outcome = 'booked';
    } else if (
      callAnalysis.agent_transfer ||
      customAnalysis.transferred ||
      disconnectionReason === 'agent_transfer' ||
      disconnectionReason === 'transfer_to_human'
    ) {
      outcome = 'transferred';
    } else if (callAnalysis.voicemail_detected || disconnectionReason === 'voicemail_reached') {
      outcome = 'voicemail';
    } else if (duration < 10) {
      outcome = 'missed';
    }

    // Record metrics
    try {
      const { recordMetric } = require('../utils/metrics');
      recordMetric('total_calls', 1, 'counter');
    } catch (_) {}

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
            score = MAX(score, ?),
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

      // 9a. Voicemail handling — different from missed call
      if (outcome === 'voicemail') {
        try {
          const voicemailLead = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(callerPhone, clientId);
          const voicemailLeadId = voicemailLead?.id || randomUUID();
          if (!voicemailLead) {
            db.prepare(`
              INSERT INTO leads (id, client_id, phone, source, score, stage, last_contact, created_at, updated_at)
              VALUES (?, ?, ?, 'voicemail', 3, 'new', datetime('now'), datetime('now'), datetime('now'))
            `).run(voicemailLeadId, clientId, callerPhone);
          }

          const voicemailClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
          if (voicemailClient) {
            const voicemailMsg = `Hi, we noticed you called ${voicemailClient.business_name}. Sorry we missed you! Book an appointment: ${voicemailClient.calcom_booking_link || '(booking link not set)'} or we'll call you back during business hours.`;
            sendSMS(callerPhone, voicemailMsg, voicemailClient.twilio_phone, db, clientId)
              .catch(err => console.error('[retell] Voicemail SMS failed:', err.message));

            db.prepare(`
              INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at)
              VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'voicemail_textback', datetime('now'))
            `).run(randomUUID(), clientId, voicemailLeadId, callerPhone, voicemailMsg);

            // Schedule one followup call during next business hours (not immediate)
            const { isWithinBusinessHours, getNextBusinessHour } = require('../utils/businessHours');
            if (!isWithinBusinessHours(voicemailClient)) {
              const nextOpen = getNextBusinessHour(voicemailClient);
              const nextOpenTime = new Date(nextOpen);
              const callbackTime = new Date(nextOpenTime.getTime() + 30 * 60 * 1000); // 30min after opening

              db.prepare(`
                INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
                VALUES (?, ?, ?, 99, 'voicemail_callback', ?, 'template', ?, 'scheduled')
              `).run(randomUUID(), voicemailLeadId, clientId, 'Voicemail callback', callbackTime.toISOString());
            }
          }
        } catch (vmErr) {
          console.error('[retell] Voicemail handler error:', vmErr.message);
        }
      }

      // 9b. Missed call (but not voicemail) — instant text-back + speed-to-lead + brain
      if (outcome === 'missed' || duration === 0) {
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

            // Instant text-back (with opt-out check)
            const textBackMsg = `Hi! Sorry we missed your call. How can we help you today? — ${missedClient.business_name || 'Our team'}`;
            sendSMS(callerPhone, textBackMsg, missedClient.twilio_phone, db, clientId)
              .catch(err => console.error('[retell] Missed call text-back failed:', err.message));

            // Log text-back in messages
            db.prepare(`
              INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at)
              VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'missed_call_textback', datetime('now'))
            `).run(randomUUID(), clientId, missedLeadId, callerPhone, textBackMsg);

            // Telegram: missed call alert
            if (missedClient.telegram_chat_id) {
              telegram.sendMessage(missedClient.telegram_chat_id,
                `&#10060; <b>Missed call</b> from ${callerPhone}\n\nAuto text-back sent.`
              ).catch(err => console.error('[retell] Telegram missed-call alert failed:', err.message));
            }

            // Speed-to-lead sequence
            const { triggerSpeedSequence } = require('../utils/speed-to-lead');
            triggerSpeedSequence(db, {
              leadId: missedLeadId, clientId, phone: callerPhone,
              name: null, email: null, message: null, service: null,
              source: 'missed_call', client: missedClient
            }).catch(err => console.error('[retell] Missed call speed sequence failed:', err.message));

            // NOTE: Brain decision for missed calls is handled by the general post-call
            // brain block below (line ~443). Removed duplicate brain call here to prevent
            // double SMS sends and duplicate follow-ups.
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
            telegram.sendMessage(clientForNotify.telegram_chat_id, text, { reply_markup: { inline_keyboard: buttons } });
          }
        }
      }
    } catch (tgErr) {
      console.error('[retell] Telegram notification failed:', tgErr.message);
    }

    console.log(`[retell] call_ended processed: ${callId} outcome=${outcome} score=${score}`);

    // === BRAIN — autonomous post-call decisions ===
    if (callerPhone && clientId) {
      try {
        const { getLeadMemory } = require('../utils/leadMemory');
        const { think } = require('../utils/brain');
        const { executeActions } = require('../utils/actionExecutor');

        if (callerPhone && clientId) {
          const memory = getLeadMemory(db, callerPhone, clientId);
          if (memory) {
            const decision = await think('call_ended', {
              call_id: callId, duration, outcome, summary, score,
            }, memory, db);
            await executeActions(db, decision.actions, memory);
          }
        }
      } catch (brainErr) {
        console.error('[Brain] Post-call error:', brainErr.message);
      }
    }
  } catch (err) {
    console.error('[retell] call_ended error:', err);
  }
}

function handleCallAnalyzed(db, call) {
  try {
    if (!call || !call.call_id) {
      console.warn('[retell] call_analyzed missing call or call_id');
      return;
    }
    const callId = call.call_id;
    const analysis = call.call_analysis || {};

    // Extract transcript if provided
    const rawTranscript = call.transcript || '';
    const transcriptText = typeof rawTranscript === 'string'
      ? rawTranscript
      : Array.isArray(rawTranscript)
        ? rawTranscript.map(t => `${t.role}: ${t.content}`).join('\n')
        : JSON.stringify(rawTranscript);

    const callSummary = analysis.call_summary || '';

    // Update call record — fill transcript and summary if not already set
    db.prepare(`
      UPDATE calls SET
        transcript = CASE WHEN (transcript IS NULL OR transcript = '') AND ? != '' THEN ? ELSE transcript END,
        summary = CASE WHEN (summary IS NULL OR summary = '' OR summary = 'Summary unavailable' OR summary = 'Call too short for summary') AND ? != '' THEN ? ELSE summary END,
        sentiment = COALESCE(?, sentiment),
        analysis_data = ?,
        updated_at = ?
      WHERE call_id = ?
    `).run(
      transcriptText, transcriptText,
      callSummary, callSummary,
      analysis.user_sentiment || null,
      JSON.stringify(analysis),
      new Date().toISOString(),
      callId
    );

    console.log(`[retell] call_analyzed: ${callId} transcript=${transcriptText.length}chars summary=${callSummary.length}chars`);
  } catch (err) {
    console.error('[retell] call_analyzed error:', err);
  }
}

async function handleTransfer(db, call) {
  try {
    if (!call || !call.call_id) {
      console.warn('[retell] transfer missing call or call_id');
      return;
    }
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
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
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
      // Skip if this touch_number already scheduled for this lead
      const existing = db.prepare(
        "SELECT id FROM followups WHERE lead_id = ? AND touch_number = ? AND status = 'scheduled'"
      ).get(leadId, touch.touchNumber);
      if (existing) {
        console.log(`[retell] Skipping duplicate followup touch ${touch.touchNumber} for lead ${leadId}`);
        continue;
      }
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
