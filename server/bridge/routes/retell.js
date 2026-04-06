const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { sendSMS, sendSMSToOwner } = require('../utils/sms');
const telegram = require('../utils/telegram');
const config = require('../utils/config');
const { logger } = require('../utils/logger');
const { generateVoicemailText, generateFollowUpSms } = require('../utils/nicheTemplates');

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

// Retell webhook signature verification (timing-safe comparison)
router.use((req, res, next) => {
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[retell] RETELL_WEBHOOK_SECRET not configured in production');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    logger.warn('[retell] Webhook signature validation disabled - set RETELL_WEBHOOK_SECRET');
    return next();
  }
  const signature = req.headers['x-retell-signature'];
  if (!signature) {
    logger.warn('[retell] Missing webhook signature header');
    return res.status(401).json({ error: 'Missing signature' });
  }
  const payload = JSON.stringify(req.body);
  const expected = require('crypto').createHmac('sha256', secret).update(payload).digest('hex');
  // Use timingSafeEqual to prevent timing attacks
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !require('crypto').timingSafeEqual(sigBuf, expBuf)) {
    logger.warn('[retell] Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  next();
});

// POST / — handles all Retell webhook events
router.post('/', (req, res) => {
  const body = req.body || {};
  const event = body.event;
  const call = body.call || {};

  // Always respond 200 immediately
  res.status(200).json({ received: true });

  if (!event) {
    logger.info('[retell] No event in payload');
    return;
  }

  const db = req.app.locals.db;
  if (!db) {
    logger.error('[retell] No database connection');
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
          handleCallEnded(db, call).catch(err => logger.error('[retell] handleCallEnded error:', err));
          break;
        case 'call_analyzed':
          handleCallAnalyzed(db, call);
          break;
        case 'agent_transfer':
        case 'transfer_requested':
          handleTransfer(db, call).catch(err => logger.error('[retell] handleTransfer error:', err));
          break;
        case 'dtmf':
          if (call && call.digit === '*') handleTransfer(db, call);
          break;
        default:
          logger.info(`[retell] Unhandled event: ${event}`);
      }
    } catch (err) {
      logger.error(`[retell] Error processing ${event}:`, err);
    }
  });
});

function handleCallStarted(db, call) {
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] call_started missing call or call_id');
      return;
    }
    const callId = call.call_id;
    const toNumber = call.to_number;
    const callerPhone = normalizePhone(call.from_number);
    const direction = call.direction || 'inbound';

    // Match client by retell phone number; fall back to agent ID for web calls
    let client = db.prepare(
      `SELECT id FROM clients WHERE retell_phone = ? OR twilio_phone = ?`
    ).get(toNumber, toNumber);

    if (!client && call.agent_id) {
      client = db.prepare('SELECT id FROM clients WHERE retell_agent_id = ?').get(call.agent_id);
    }

    const clientId = client?.id || null;

    if (!clientId) {
      logger.warn(`[retell] call_started: no matching client for ${callId} toNumber=${toNumber}`);
      return;
    }

    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(call_id) DO UPDATE SET updated_at = datetime('now')
    `).run(randomUUID(), callId, clientId, callerPhone, direction, new Date().toISOString());

    logger.info(`[retell] call_started: ${callId} client=${clientId} from=${callerPhone ? callerPhone.replace(/\d(?=\d{4})/g, '*') : '?'}`);
  } catch (err) {
    logger.error('[retell] call_started error:', err);
  }
}

async function handleCallEnded(db, call) {
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] call_ended missing call or call_id');
      return;
    }
    const callId = call.call_id;
    logger.info(`[retell] call_ended: ${callId}`);

    // Idempotency: skip if this call_ended was already processed (webhook retry)
    const alreadyProcessed = db.prepare(
      "SELECT id FROM calls WHERE call_id = ? AND outcome IS NOT NULL"
    ).get(callId);
    if (alreadyProcessed) {
      logger.info(`[retell] call_ended: ${callId} already processed, skipping (idempotent)`);
      return;
    }

    // 1. Fetch full call data from Retell (fall back to webhook payload on failure)
    const callData = await fetchCallTranscript(callId);

    const transcript = callData.transcript || '';
    const duration = callData.call_length || call.duration || call.call_length || 0;
    const callAnalysis = callData.call_analysis || call.call_analysis || {};
    const customAnalysis = callData.custom_analysis_data || call.custom_analysis_data || {};

    // 2. Get existing call record (or create one if call_started was missed)
    let callRecord = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
    if (!callRecord) {
      logger.warn(`[retell] No call record for ${callId} — inserting from call_ended payload`);
      const toNumber = callData.to_number || call.to_number;
      const fromNumber = normalizePhone(callData.from_number || call.from_number);
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
        logger.warn(`[retell] No matching client for call ${callId} — cannot insert (client_id NOT NULL)`);
        return;
      }

      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(call_id) DO UPDATE SET updated_at = datetime('now')
      `).run(randomUUID(), callId, insertedClientId, fromNumber || null, callData.direction || call.direction || 'inbound', new Date().toISOString());

      callRecord = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
      if (!callRecord) {
        logger.error(`[retell] Failed to create call record for ${callId}`);
        return;
      }
    }

    let transcriptText = typeof transcript === 'string'
      ? transcript
      : Array.isArray(transcript)
        ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
        : JSON.stringify(transcript);

    // Cap transcript length to prevent oversized DB writes
    if (transcriptText && transcriptText.length > 100000) {
      transcriptText = transcriptText.substring(0, 100000) + '\n[...truncated]';
    }

    // 3. Generate summary and score
    const { summary, score } = await generateCallSummaryAndScore(transcriptText, callAnalysis, duration);

    // 4. Determine outcome
    const bookingId = customAnalysis.calcom_booking_id || callData.metadata?.calcom_booking_id;
    const outcome = determineOutcome(callData, call, callAnalysis, customAnalysis, duration, bookingId);

    // Record metrics
    try {
      const { recordMetric } = require('../utils/metrics');
      recordMetric('total_calls', 1, 'counter');
    } catch (err) {
      logger.error('[retell] Failed to record metric:', err.message);
    }

    const sentiment = callAnalysis.user_sentiment || 'neutral';

    // 5. Update call record
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

    // Broadcast real-time update
    try {
      const { broadcast } = require('../utils/websocket');
      broadcast('new_call', {
        id: callId,
        phone: callRecord.caller_phone,
        status: outcome,
        duration,
        score,
        summary
      });
    } catch (err) {
      logger.warn('[retell] WebSocket broadcast error:', err.message);
    }

    // 6. Upsert lead
    const callerPhone = callRecord.caller_phone;
    const clientId = callRecord.client_id;

    if (callerPhone && clientId) {
      // Atomic lead upsert — single statement to prevent race conditions on concurrent webhooks
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, score, stage, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'new', datetime('now'), datetime('now'), datetime('now'))
        ON CONFLICT(client_id, phone) DO UPDATE SET
          score = MAX(score, excluded.score),
          last_contact = excluded.last_contact,
          stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END,
          updated_at = datetime('now')
      `).run(randomUUID(), clientId, callerPhone, score);

      // 7. Store booking reference
      if (bookingId) {
        const lead = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(callerPhone, clientId);
        if (lead) {
          db.prepare(`
            UPDATE leads SET calcom_booking_id = ?, stage = 'booked', updated_at = ? WHERE id = ?
          `).run(bookingId, new Date().toISOString(), lead.id);
        }
      }

      // 8. Schedule follow-up SMS sequence
      if (outcome !== 'missed' && outcome !== 'voicemail') {
        scheduleFollowUp(db, clientId, callerPhone, outcome);
      }

      // 8a. Voicemail handling — different from missed call
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
            const voicemailMsg = generateVoicemailText(voicemailClient, callerPhone);
            const voicemailPhone = voicemailClient.telnyx_phone || voicemailClient.twilio_phone;
            sendSMS(callerPhone, voicemailMsg, voicemailPhone, db, clientId)
              .catch(err => logger.error('[retell] Voicemail SMS failed:', err.message));

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
          logger.error('[retell] Voicemail handler error:', vmErr.message);
        }
      }

      // 8b. Missed call (but not voicemail) — instant text-back + speed-to-lead + brain
      if (outcome === 'missed' || duration === 0) {
        const missedClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
        if (missedClient) {
          await handleMissedCall(db, clientId, callerPhone, missedClient);
        }
      }

      // 9. Notify owner on transfer or complaint
      const isComplaint = sentiment === 'negative' || (summary && summary.toLowerCase().includes('complaint'));
      if (outcome === 'transferred' || isComplaint) {
        const client = db.prepare('SELECT owner_phone, business_name FROM clients WHERE id = ?').get(clientId);
        if (client?.owner_phone) {
          const reason = outcome === 'transferred' ? 'Transfer' : 'Complaint detected';
          await sendSMS(
            client.owner_phone,
            `[ELYVN] ${reason} — ${client.business_name}\nCaller: ${callerPhone}\n${summary}`
          ).catch(err => logger.error('[retell] Owner SMS failed:', err.message));
        }
      }
    }

    // === Telegram notification ===
    await notifyOwnerOfCall(db, clientId, callId, outcome, summary);

    logger.info(`[retell] call_ended processed: ${callId} outcome=${outcome} score=${score}`);

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
        logger.error('[Brain] Post-call error:', brainErr.message);
      }
    }
  } catch (err) {
    logger.error('[retell] call_ended error:', err);
  }
}

function handleCallAnalyzed(db, call) {
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] call_analyzed missing call or call_id');
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

    logger.info(`[retell] call_analyzed: ${callId} transcript=${transcriptText.length}chars summary=${callSummary.length}chars`);
  } catch (err) {
    logger.error('[retell] call_analyzed error:', err);
  }
}

async function handleTransfer(db, call) {
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] transfer missing call or call_id');
      return;
    }
    const callId = call.call_id;
    const callerPhone = call.from_number;
    logger.info(`[retell] transfer: ${callId}`);

    // Fetch transcript (with timeout)
    const retellResp = await fetch(`${RETELL_BASE}/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
      signal: AbortSignal.timeout(10000),
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
          model: config.ai.model,
          max_tokens: 100,
          messages: [{ role: 'user', content: `Summarize this call in 2 sentences for the business owner who is about to receive a transfer:\n\n${transcriptText}` }]
        });
        summary = summaryResp.content[0]?.text || summary;
      } catch (err) {
        logger.error('[retell] Transfer summary generation failed:', err.message);
      }
    }

    // Update call outcome
    db.prepare(`
      UPDATE calls SET outcome = 'transferred', summary = ?, updated_at = ? WHERE call_id = ?
    `).run(summary, new Date().toISOString(), callId);

    // Find client and notify owner + transfer number
    const callRecord = db.prepare('SELECT client_id FROM calls WHERE call_id = ?').get(callId);
    if (callRecord?.client_id) {
      const client = db.prepare('SELECT owner_phone, transfer_phone, telegram_chat_id, business_name FROM clients WHERE id = ?').get(callRecord.client_id);
      const transferTarget = client?.transfer_phone || client?.owner_phone;
      if (transferTarget) {
        await sendSMS(
          transferTarget,
          `📞 Transfer incoming from ${callerPhone || 'unknown'} — ${summary}\n\nCall your Retell number and press * to connect.`
        ).catch(err => logger.error('[retell] Transfer SMS failed:', err.message));
        // Also notify owner if transfer_phone is different from owner_phone
        if (client?.transfer_phone && client?.owner_phone && client.transfer_phone !== client.owner_phone) {
          await sendSMS(
            client.owner_phone,
            `Transfer routed to ${client.transfer_phone} from ${callerPhone || 'unknown'} — ${summary}`
          ).catch(err => logger.error('[retell] Owner transfer notify SMS failed:', err.message));
        }
      }

      // === Telegram transfer alert ===
      try {
        if (client?.telegram_chat_id) {
          const { text } = telegram.formatTransferAlert(
            { caller_name: callerPhone, caller_phone: callerPhone },
            summary,
            client
          );
          telegram.sendMessage(client.telegram_chat_id, text);
        }
      } catch (tgErr) {
        logger.error('[retell] Telegram transfer alert failed:', tgErr.message);
      }
    }
  } catch (err) {
    logger.error('[retell] transfer error:', err);
  }
}

function scheduleFollowUp(db, clientId, callerPhone, outcome) {
  try {
    // Find lead for this phone
    const lead = db.prepare(
      'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
    ).get(callerPhone, clientId);

    if (!lead) {
      logger.info(`[retell] No lead found for ${callerPhone}, skipping follow-up`);
      return;
    }

    const leadId = lead.id;
    const now = new Date();

    // Load client for niche-aware follow-up content
    const followUpClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    const biz = followUpClient?.business_name || followUpClient?.name || 'us';

    const touches = outcome === 'booked'
      ? [
          { touchNumber: 1, type: 'confirmation', delayMs: 5 * 60 * 1000,
            content: generateFollowUpSms(followUpClient || {}, null, `Your appointment with ${biz} is confirmed! Reply CANCEL to cancel.`) },
          { touchNumber: 2, type: 'reminder', delayMs: 24 * 60 * 60 * 1000,
            content: generateFollowUpSms(followUpClient || {}, null, `Reminder: your appointment with ${biz} is coming up soon!`) }
        ]
      : [
          { touchNumber: 1, type: 'thank_you', delayMs: 2 * 60 * 60 * 1000,
            content: generateFollowUpSms(followUpClient || {}, null, `Thanks for calling ${biz}! Book online anytime: ${followUpClient?.calcom_booking_link || ''}`) },
          { touchNumber: 2, type: 'nudge', delayMs: 48 * 60 * 60 * 1000,
            content: generateFollowUpSms(followUpClient || {}, null, `Still need service? ${biz} has availability this week.`) }
        ];

    // Batch-load all scheduled followups for this lead to avoid N+1 queries
    const existingFollowups = db.prepare(
      "SELECT touch_number FROM followups WHERE lead_id = ? AND status = 'scheduled'"
    ).all(leadId);
    const existingTouchNumbers = new Set(existingFollowups.map(f => f.touch_number));

    for (const touch of touches) {
      // Skip if this touch_number already scheduled for this lead
      if (existingTouchNumbers.has(touch.touchNumber)) {
        logger.info(`[retell] Skipping duplicate followup touch ${touch.touchNumber} for lead ${leadId}`);
        continue;
      }
      const scheduledAt = new Date(now.getTime() + touch.delayMs);
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'template', ?, 'scheduled')
      `).run(randomUUID(), leadId, clientId, touch.touchNumber, touch.type, touch.content, scheduledAt.toISOString());
    }

    logger.info(`[retell] Scheduled ${touches.length} follow-ups for ${callerPhone}`);
  } catch (err) {
    logger.error('[retell] scheduleFollowUp error:', err);
  }
}

// === Extracted helper functions for handleCallEnded ===

async function fetchCallTranscript(callId) {
  if (!RETELL_API_KEY) {
    logger.warn('[retell] No RETELL_API_KEY — using webhook payload data only');
    return {};
  }
  try {
    const retellResp = await fetch(`${RETELL_BASE}/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    if (retellResp.ok) {
      return await retellResp.json();
    }
    logger.warn(`[retell] Retell API fetch failed for ${callId} (${retellResp.status}), using webhook payload`);
    return {};
  } catch (fetchErr) {
    logger.warn(`[retell] Retell API fetch error for ${callId}:`, fetchErr.message, '— using webhook payload');
    return {};
  }
}

async function generateCallSummary(transcriptText, callAnalysis) {
  const hasTranscript = transcriptText && transcriptText.trim().length >= 10;
  const analysisSummary = callAnalysis.call_summary || '';

  if (!hasTranscript && !analysisSummary) {
    return 'Summary unavailable';
  }

  try {
    const summaryResp = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 150,
      messages: [{ role: 'user', content: hasTranscript
        ? `Summarize this phone call transcript in exactly 2 lines. Be specific about what was discussed and any outcomes:\n\n${transcriptText}`
        : `Rewrite this call summary in 2 clear lines for a business owner:\n\n${analysisSummary}` }]
    });
    return summaryResp.content[0]?.text || analysisSummary || 'Summary unavailable';
  } catch (err) {
    logger.error('[retell] Summary generation failed:', err.message);
    return analysisSummary || 'Summary unavailable';
  }
}

async function scoreCall(transcriptText, callAnalysis) {
  const hasTranscript = transcriptText && transcriptText.trim().length >= 10;
  const analysisSummary = callAnalysis.call_summary || '';
  const scoringText = hasTranscript ? transcriptText : analysisSummary;

  if (scoringText.length < 10) return 5;

  try {
    const scoreResp = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 10,
      messages: [{ role: 'user', content: `Score this lead 1-10 based on their interest, urgency, and qualification from this call ${hasTranscript ? 'transcript' : 'summary'}. Reply with ONLY a single number:\n\n${scoringText}` }]
    });
    const parsed = parseInt(scoreResp.content[0]?.text?.trim(), 10);
    if (parsed >= 1 && parsed <= 10) return parsed;
    return 5;
  } catch (err) {
    logger.error('[retell] Lead scoring failed:', err.message);
    return 5;
  }
}

async function generateCallSummaryAndScore(transcriptText, callAnalysis, duration) {
  const hasTranscript = transcriptText && transcriptText.trim().length >= 10;
  const analysisSummary = callAnalysis.call_summary || '';
  const scoringText = hasTranscript ? transcriptText : analysisSummary;

  if (duration <= 15 && !hasTranscript && !analysisSummary) {
    return { summary: 'Call too short for summary', score: 5 };
  }

  if (scoringText.length >= 10) {
    const summary = await generateCallSummary(transcriptText, callAnalysis);
    const score = await scoreCall(transcriptText, callAnalysis);
    return { summary, score };
  }

  return { summary: analysisSummary || 'Summary unavailable', score: 5 };
}

function determineOutcome(callData, call, callAnalysis, customAnalysis, duration, bookingId) {
  const disconnectionReason = callData.disconnection_reason || call.disconnection_reason || '';

  if (bookingId) {
    return 'booked';
  } else if (
    callAnalysis.agent_transfer ||
    customAnalysis.transferred ||
    disconnectionReason === 'agent_transfer' ||
    disconnectionReason === 'transfer_to_human'
  ) {
    return 'transferred';
  } else if (callAnalysis.voicemail_detected || disconnectionReason === 'voicemail_reached') {
    return 'voicemail';
  } else if (duration < 10) {
    return 'missed';
  }
  return 'info_provided';
}

async function handleMissedCall(db, clientId, callerPhone, client) {
  try {
    const missedLead = db.prepare('SELECT id FROM leads WHERE phone = ? AND client_id = ?').get(callerPhone, clientId);
    const missedLeadId = missedLead?.id || randomUUID();
    if (!missedLead) {
      db.prepare(`
        INSERT INTO leads (id, client_id, phone, source, score, stage, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, 'missed_call', 5, 'new', datetime('now'), datetime('now'), datetime('now'))
      `).run(missedLeadId, clientId, callerPhone);
    }

    // Instant text-back (with opt-out check)
    const textBackMsg = `Hi! Sorry we missed your call. How can we help you today? — ${client.business_name || 'Our team'}`;
    const missedCallPhone = client.telnyx_phone || client.twilio_phone;
    await sendSMS(callerPhone, textBackMsg, missedCallPhone, db, clientId)
      .catch(err => logger.error('[retell] Missed call text-back failed:', err.message));

    // Log text-back in messages
    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'missed_call_textback', datetime('now'))
    `).run(randomUUID(), clientId, missedLeadId, callerPhone, textBackMsg);

    // Telegram: missed call alert (always send — missed calls are critical)
    if (client.telegram_chat_id) {
      await telegram.sendMessage(client.telegram_chat_id,
        `&#10060; <b>Missed call</b> from ${callerPhone}\n\nAuto text-back sent.`
      ).catch(err => logger.error('[retell] Telegram missed-call alert failed:', err.message));
    }

    // Speed-to-lead sequence — skip if an active sequence already exists for this lead
    const activeSequence = db.prepare(
      "SELECT id FROM followups WHERE lead_id = ? AND status = 'scheduled' AND scheduled_at >= datetime('now', '-6 hours') LIMIT 1"
    ).get(missedLeadId);
    if (activeSequence) {
      logger.info(`[retell] Skipping speed sequence for ${callerPhone} — active sequence already exists`);
    } else {
      const { triggerSpeedSequence } = require('../utils/speed-to-lead');
      triggerSpeedSequence(db, {
        leadId: missedLeadId, clientId, phone: callerPhone,
        name: null, email: null, message: null, service: null,
        source: 'missed_call', client
      })
        .catch(err => logger.error('[retell] Missed call speed sequence failed:', err.message));
    }

    // NOTE: Brain decision for missed calls is handled by the general post-call
    // brain block in handleCallEnded. Removed duplicate brain call here to prevent
    // double SMS sends and duplicate follow-ups.
  } catch (missedErr) {
    logger.error('[retell] Missed call handler error:', missedErr.message);
  }
}

async function notifyOwnerOfCall(db, clientId, callId, outcome, summary) {
  try {
    const clientForNotify = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    const telegramChatId = (clientForNotify && clientForNotify.telegram_chat_id) || process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (telegramChatId && (!clientForNotify || clientForNotify.notification_mode !== 'digest')) {
      const processedCall = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
      if (processedCall) {
        if (outcome === 'transferred') {
          const { text } = telegram.formatTransferAlert(processedCall, summary, clientForNotify);
          telegram.sendMessage(telegramChatId, text)
            .catch(err => logger.error('[retell] Telegram transfer notify failed:', err.message));
        } else {
          const { text, buttons } = telegram.formatCallNotification(processedCall, clientForNotify);
          telegram.sendMessage(telegramChatId, text, { reply_markup: { inline_keyboard: buttons } })
            .catch(err => logger.error('[retell] Telegram call notify failed:', err.message));
        }
      }
    }
  } catch (tgErr) {
    logger.error('[retell] Telegram notification failed:', tgErr.message);
  }
}

module.exports = router;
