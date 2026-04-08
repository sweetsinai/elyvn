'use strict';

/**
 * followups.js — Follow-up scheduling, missed-call handling, owner notifications
 *
 * Owns: scheduleFollowUp, handleMissedCall, notifyOwnerOfCall
 */

const { randomUUID } = require('crypto');
const { sendSMS } = require('../../utils/sms');
const telegram = require('../../utils/telegram');
const { logger } = require('../../utils/logger');
const { generateVoicemailText, generateFollowUpSms } = require('../../utils/nicheTemplates');
const { addTraceHeaders } = require('../../utils/tracing');
const config = require('../../utils/config');

async function scheduleFollowUp(db, clientId, callerPhone, outcome) {
  try {
    const lead = await db.query(
      'SELECT id FROM leads WHERE phone = ? AND client_id = ?',
      [callerPhone, clientId],
      'get'
    );

    if (!lead) {
      logger.info(`[retell] No lead found for ${callerPhone}, skipping follow-up`);
      return;
    }

    const leadId = lead.id;
    const now = new Date();

    const followUpClient = await db.query('SELECT * FROM clients WHERE id = ?', [clientId], 'get');
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

    const existingFollowups = await db.query(
      "SELECT touch_number FROM followups WHERE lead_id = ? AND status = 'scheduled'",
      [leadId],
      'all'
    );
    const existingTouchNumbers = new Set(existingFollowups.map(f => f.touch_number));

    for (const touch of touches) {
      if (existingTouchNumbers.has(touch.touchNumber)) {
        logger.info(`[retell] Skipping duplicate followup touch ${touch.touchNumber} for lead ${leadId}`);
        continue;
      }
      const scheduledAt = new Date(now.getTime() + touch.delayMs);
      await db.query(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'template', ?, 'scheduled')
      `, [randomUUID(), leadId, clientId, touch.touchNumber, touch.type, touch.content, scheduledAt.toISOString()], 'run');
    }

    logger.info(`[retell] Scheduled ${touches.length} follow-ups for ${callerPhone}`);
  } catch (err) {
    logger.error('[retell] scheduleFollowUp error:', err);
  }
}

async function handleMissedCall(db, clientId, callerPhone, client) {
  try {
    const missedLead = await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ?', [callerPhone, clientId], 'get');
    const missedLeadId = missedLead?.id || randomUUID();
    if (!missedLead) {
      await db.query(`
        INSERT INTO leads (id, client_id, phone, source, score, stage, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, 'missed_call', 5, 'new', datetime('now'), datetime('now'), datetime('now'))
      `, [missedLeadId, clientId, callerPhone], 'run');
    }

    const textBackMsg = `Hi! Sorry we missed your call. How can we help you today? — ${client.business_name || 'Our team'}`;
    const missedCallPhone = client.telnyx_phone || client.twilio_phone;
    await sendSMS(callerPhone, textBackMsg, missedCallPhone, db, clientId)
      .catch(err => logger.error('[retell] Missed call text-back failed:', err.message));

    await db.query(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'missed_call_textback', datetime('now'))
    `, [randomUUID(), clientId, missedLeadId, callerPhone, textBackMsg], 'run');

    if (client.telegram_chat_id) {
      await telegram.sendMessage(client.telegram_chat_id,
        `&#10060; <b>Missed call</b> from ${callerPhone}\n\nAuto text-back sent.`
      ).catch(err => logger.error('[retell] Telegram missed-call alert failed:', err.message));
    }

    const activeSequence = await db.query(
      "SELECT id FROM followups WHERE lead_id = ? AND status = 'scheduled' AND scheduled_at >= datetime('now', '-6 hours') LIMIT 1",
      [missedLeadId],
      'get'
    );
    if (activeSequence) {
      logger.info(`[retell] Skipping speed sequence for ${callerPhone} — active sequence already exists`);
    } else {
      const { triggerSpeedSequence } = require('../../utils/speed-to-lead');
      triggerSpeedSequence(db, {
        leadId: missedLeadId, clientId, phone: callerPhone,
        name: null, email: null, message: null, service: null,
        source: 'missed_call', client
      })
        .catch(err => logger.error('[retell] Missed call speed sequence failed:', err.message));
    }

    // Brain decision for missed calls is handled by the general post-call brain
    // block in handleCallEnded — no duplicate call here.
  } catch (missedErr) {
    logger.error('[retell] Missed call handler error:', missedErr.message);
  }
}

async function notifyOwnerOfCall(db, clientId, callId, outcome, summary) {
  try {
    const clientForNotify = await db.query('SELECT * FROM clients WHERE id = ?', [clientId], 'get');
    const telegramChatId = (clientForNotify && clientForNotify.telegram_chat_id) || process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (telegramChatId && (!clientForNotify || clientForNotify.notification_mode !== 'digest')) {
      const processedCall = await db.query('SELECT * FROM calls WHERE call_id = ?', [callId], 'get');
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

async function handleVoicemail(db, clientId, callerPhone, voicemailLeadInitial) {
  try {
    const voicemailLead = voicemailLeadInitial || await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ?', [callerPhone, clientId], 'get');
    const voicemailLeadId = voicemailLead?.id || randomUUID();
    if (!voicemailLead) {
      await db.query(`
        INSERT INTO leads (id, client_id, phone, source, score, stage, last_contact, created_at, updated_at)
        VALUES (?, ?, ?, 'voicemail', 3, 'new', datetime('now'), datetime('now'), datetime('now'))
      `, [voicemailLeadId, clientId, callerPhone], 'run');
    }

    const voicemailClient = await db.query('SELECT * FROM clients WHERE id = ?', [clientId], 'get');
    if (!voicemailClient) return;

    const voicemailMsg = generateVoicemailText(voicemailClient, callerPhone);
    const voicemailPhone = voicemailClient.telnyx_phone || voicemailClient.twilio_phone;
    sendSMS(callerPhone, voicemailMsg, voicemailPhone, db, clientId)
      .catch(err => logger.error('[retell] Voicemail SMS failed:', err.message));

    await db.query(`
      INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, created_at)
      VALUES (?, ?, ?, ?, 'sms', 'outbound', ?, 'voicemail_textback', datetime('now'))
    `, [randomUUID(), clientId, voicemailLeadId, callerPhone, voicemailMsg], 'run');

    const { isWithinBusinessHours, getNextBusinessHour } = require('../../utils/businessHours');
    if (!isWithinBusinessHours(voicemailClient)) {
      const nextOpen = getNextBusinessHour(voicemailClient);
      const nextOpenTime = new Date(nextOpen);
      const callbackTime = new Date(nextOpenTime.getTime() + 30 * 60 * 1000);

      await db.query(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES (?, ?, ?, 99, 'voicemail_callback', ?, 'template', ?, 'scheduled')
      `, [randomUUID(), voicemailLeadId, clientId, 'Voicemail callback', callbackTime.toISOString()], 'run');
    }
  } catch (vmErr) {
    logger.error('[retell] Voicemail handler error:', vmErr.message);
  }
}

/**
 * processLeadFromCall — upsert lead, fire events, dispatch followup/voicemail/missed sequences,
 * and notify owner. Called from handleCallEnded after the call record is updated.
 */
async function processLeadFromCall(db, { callRecord, callId, outcome, summary, score, sentiment, duration, bookingId }) {
  const { randomUUID: uuid } = require('crypto');
  const { appendEvent, Events } = require('../../utils/eventStore');
  const callerPhone = callRecord.caller_phone;
  const clientId = callRecord.client_id;

  if (!callerPhone || !clientId) return;

  await db.query(`
    INSERT INTO leads (id, client_id, phone, score, stage, last_contact, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'new', datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(client_id, phone) DO UPDATE SET
      score = MAX(score, excluded.score),
      last_contact = excluded.last_contact,
      stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END,
      updated_at = datetime('now')
  `, [uuid(), clientId, callerPhone, score], 'run');

  // Lead lifecycle events
  try {
    const evtLead = await db.query('SELECT id, stage FROM leads WHERE phone = ? AND client_id = ?', [callerPhone, clientId], 'get');
    if (evtLead) {
      appendEvent(db, evtLead.id, 'lead', Events.LeadCreated, { phone: callerPhone, source: 'call', outcome, score }, clientId);
      if (evtLead.stage !== 'new') {
        appendEvent(db, evtLead.id, 'lead', Events.LeadStageChanged, { from: 'new', to: evtLead.stage, trigger: 'call_ended' }, clientId);
      }
    }
  } catch (_) {}

  // Booking reference
  if (bookingId) {
    const lead = await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ?', [callerPhone, clientId], 'get');
    if (lead) {
      await db.query(`
        UPDATE leads SET calcom_booking_id = ?, stage = 'booked', updated_at = ? WHERE id = ?
      `, [bookingId, new Date().toISOString(), lead.id], 'run');
      try { appendEvent(db, lead.id, 'lead', Events.LeadStageChanged, { from: 'contacted', to: 'booked', trigger: 'booking', bookingId }, clientId); } catch (_) {}
    }
  }

  // Follow-up sequences
  if (outcome !== 'missed' && outcome !== 'voicemail') {
    await scheduleFollowUp(db, clientId, callerPhone, outcome);
  }

  if (outcome === 'voicemail') {
    const vmLead = await db.query('SELECT id FROM leads WHERE phone = ? AND client_id = ?', [callerPhone, clientId], 'get');
    await handleVoicemail(db, clientId, callerPhone, vmLead);
  }

  if (outcome === 'missed' || duration === 0) {
    const missedClient = await db.query('SELECT * FROM clients WHERE id = ?', [clientId], 'get');
    if (missedClient) await handleMissedCall(db, clientId, callerPhone, missedClient);
  }

  // Owner SMS on transfer or complaint
  const isComplaint = sentiment === 'negative' || (summary && summary.toLowerCase().includes('complaint'));
  if (outcome === 'transferred' || isComplaint) {
    const client = await db.query('SELECT owner_phone, business_name FROM clients WHERE id = ?', [clientId], 'get');
    if (client?.owner_phone) {
      const reason = outcome === 'transferred' ? 'Transfer' : 'Complaint detected';
      await sendSMS(
        client.owner_phone,
        `[ELYVN] ${reason} — ${client.business_name}\nCaller: ${callerPhone}\n${summary}`
      ).catch(err => logger.error('[retell] Owner SMS failed:', err.message));
    }
  }
}

async function handleTransfer(db, call, correlationId) {
  const { retellBreaker, anthropicBreaker } = require('./brain');
  const RETELL_BASE = 'https://api.retellai.com/v2';
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] transfer missing call or call_id', { correlationId });
      return;
    }
    const callId = call.call_id;
    const callerPhone = call.from_number;
    logger.info(`[retell] transfer: ${callId}`, { correlationId });

    let retellResp = null;
    try {
      retellResp = await retellBreaker.call(`${RETELL_BASE}/get-call/${callId}`, {
        headers: addTraceHeaders({ 'Authorization': `Bearer ${process.env.RETELL_API_KEY}` }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (fetchErr) {
      logger.warn(`[retell] handleTransfer: Retell fetch failed for ${callId}:`, { correlationId, error: fetchErr.message });
    }

    let summary = 'Transfer requested';
    if (retellResp && !retellResp.fallback) {
      const callData = await retellResp.json();
      const transcript = callData.transcript || '';
      const transcriptText = typeof transcript === 'string'
        ? transcript
        : Array.isArray(transcript)
          ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
          : JSON.stringify(transcript);

      try {
        const summaryResp = await anthropicBreaker.call({
          model: config.ai.model,
          max_tokens: 100,
          messages: [{ role: 'user', content: `Summarize this call in 2 sentences for the business owner who is about to receive a transfer:\n\n${transcriptText}` }]
        });
        if (summaryResp.fallback) {
          logger.warn('[retell] Anthropic circuit breaker fallback for transfer summary');
        } else {
          summary = summaryResp.content[0]?.text || summary;
        }
      } catch (err) {
        logger.error('[retell] Transfer summary generation failed:', err.message);
      }
    }

    await db.query(`
      UPDATE calls SET outcome = 'transferred', summary = ?, updated_at = ? WHERE call_id = ?
    `, [summary, new Date().toISOString(), callId], 'run');

    const callRecord = await db.query('SELECT client_id FROM calls WHERE call_id = ?', [callId], 'get');
    if (callRecord?.client_id) {
      const client = await db.query('SELECT owner_phone, transfer_phone, telegram_chat_id, business_name FROM clients WHERE id = ?', [callRecord.client_id], 'get');
      const transferTarget = client?.transfer_phone || client?.owner_phone;
      if (transferTarget) {
        await sendSMS(
          transferTarget,
          `📞 Transfer incoming from ${callerPhone || 'unknown'} — ${summary}\n\nCall your Retell number and press * to connect.`
        ).catch(err => logger.error('[retell] Transfer SMS failed:', err.message));
        if (client?.transfer_phone && client?.owner_phone && client.transfer_phone !== client.owner_phone) {
          await sendSMS(
            client.owner_phone,
            `Transfer routed to ${client.transfer_phone} from ${callerPhone || 'unknown'} — ${summary}`
          ).catch(err => logger.error('[retell] Owner transfer notify SMS failed:', err.message));
        }
      }

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
    logger.error('[retell] transfer error:', { correlationId, error: err.message, stack: err.stack });
  }
}

module.exports = {
  scheduleFollowUp,
  handleMissedCall,
  handleVoicemail,
  handleTransfer,
  notifyOwnerOfCall,
  processLeadFromCall,
};
