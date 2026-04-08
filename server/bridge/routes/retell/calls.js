'use strict';

/**
 * calls.js — Call lifecycle event handlers
 *
 * Owns: handleCallStarted, handleCallEnded, handleCallAnalyzed, handleTransfer
 */

const { randomUUID } = require('crypto');
const { normalizePhone } = require('../../utils/phone');
const { logger } = require('../../utils/logger');
const queryCache = require('../../utils/queryCache');

const {
  fetchCallTranscript,
  generateCallSummaryAndScore,
  determineOutcome,
} = require('./brain');

const {
  notifyOwnerOfCall,
  processLeadFromCall,
} = require('./followups');

const AGENT_CONFIG_TTL = 300 * 1000; // 300 seconds — agent configs rarely change

/**
 * Look up a client by retell_agent_id with a 5-minute cache.
 * Phone-number lookups are skipped — those change more frequently.
 */
async function lookupClientByAgentId(db, agentId) {
  if (!agentId) return null;
  const cacheKey = `agent:${agentId}`;
  const cached = queryCache.get(cacheKey);
  if (cached !== null) return cached;
  const client = await db.query('SELECT id FROM clients WHERE retell_agent_id = ?', [agentId], 'get');
  queryCache.set(cacheKey, client || null, AGENT_CONFIG_TTL);
  return client || null;
}

async function handleCallStarted(db, call, correlationId) {
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] call_started missing call or call_id', { correlationId });
      return;
    }
    const callId = call.call_id;
    const toNumber = call.to_number;
    const callerPhone = normalizePhone(call.from_number);
    const direction = call.direction || 'inbound';

    let client = await db.query(
      `SELECT id FROM clients WHERE retell_phone = ? OR twilio_phone = ?`,
      [toNumber, toNumber],
      'get'
    );

    if (!client && call.agent_id) {
      client = await lookupClientByAgentId(db, call.agent_id);
    }

    const clientId = client?.id || null;

    if (!clientId) {
      logger.warn(`[retell] call_started: no matching client for ${callId} toNumber=${toNumber}`, { correlationId });
      return;
    }

    await db.query(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(call_id) DO UPDATE SET updated_at = datetime('now')
    `, [randomUUID(), callId, clientId, callerPhone, direction, new Date().toISOString()], 'run');

    logger.info(`[retell] call_started: ${callId} client=${clientId} from=${callerPhone ? callerPhone.replace(/\d(?=\d{4})/g, '*') : '?'}`, { correlationId });
  } catch (err) {
    logger.error('[retell] call_started error:', { correlationId, error: err.message, stack: err.stack });
  }
}

/**
 * Idempotency check — returns true if the call has already been processed.
 */
async function checkCallProcessed(db, callId, correlationId) {
  try {
    const alreadyProcessed = await db.query(
      "SELECT id FROM calls WHERE call_id = ? AND outcome IS NOT NULL",
      [callId],
      'get'
    );
    if (alreadyProcessed) {
      logger.info(`[retell] call_ended: ${callId} already processed, skipping (idempotent)`, { correlationId });
      return true;
    }
    return false;
  } catch (err) {
    logger.error(`[retell] checkCallProcessed error for ${callId}:`, { correlationId, error: err.message, stack: err.stack });
    throw err;
  }
}

/**
 * Fetch full call data from Retell and ensure a call record exists in the DB.
 * Returns { callData, callRecord } or null if a call record cannot be established.
 */
async function fetchCallDataFromRetell(db, call, correlationId) {
  const callId = call.call_id;
  try {
    const callData = await fetchCallTranscript(callId);

    let callRecord = await db.query('SELECT * FROM calls WHERE call_id = ?', [callId], 'get');
    if (!callRecord) {
      logger.warn(`[retell] No call record for ${callId} — inserting from call_ended payload`, { correlationId });
      const toNumber = callData.to_number || call.to_number;
      const fromNumber = normalizePhone(callData.from_number || call.from_number);
      const agentId = callData.agent_id || call.agent_id;

      let client = null;
      if (toNumber) {
        client = await db.query('SELECT id FROM clients WHERE retell_phone = ? OR twilio_phone = ?', [toNumber, toNumber], 'get');
      }
      if (!client && agentId) {
        client = await lookupClientByAgentId(db, agentId);
      }
      const insertedClientId = client?.id || null;

      if (!insertedClientId) {
        logger.warn(`[retell] No matching client for call ${callId} — cannot insert (client_id NOT NULL)`, { correlationId });
        return null;
      }

      await db.query(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(call_id) DO UPDATE SET updated_at = datetime('now')
      `, [randomUUID(), callId, insertedClientId, fromNumber || null, callData.direction || call.direction || 'inbound', new Date().toISOString()], 'run');

      callRecord = await db.query('SELECT * FROM calls WHERE call_id = ?', [callId], 'get');
      if (!callRecord) {
        logger.error(`[retell] Failed to create call record for ${callId}`, { correlationId });
        return null;
      }
    }

    return { callData, callRecord };
  } catch (err) {
    logger.error(`[retell] fetchCallDataFromRetell error for ${callId}:`, { correlationId, error: err.message, stack: err.stack });
    throw err;
  }
}

/**
 * Analyze the call conversation: normalize transcript, generate summary/score,
 * determine outcome, update the DB record, and fire real-time broadcasts.
 * Returns { summary, score, outcome, sentiment, duration, bookingId, transcriptText }.
 */
async function analyzeCallConversation(db, callRecord, callData, call, correlationId) {
  const callId = call.call_id;
  try {
    const transcript = callData.transcript || '';
    const duration = callData.call_length || call.duration || call.call_length || 0;
    const callAnalysis = callData.call_analysis || call.call_analysis || {};
    const customAnalysis = callData.custom_analysis_data || call.custom_analysis_data || {};

    let transcriptText = typeof transcript === 'string'
      ? transcript
      : Array.isArray(transcript)
        ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
        : JSON.stringify(transcript);

    if (transcriptText && transcriptText.length > 100000) {
      transcriptText = transcriptText.substring(0, 100000) + '\n[...truncated]';
    }

    const { summary, score } = await generateCallSummaryAndScore(transcriptText, callAnalysis, duration);

    const bookingId = customAnalysis.calcom_booking_id || callData.metadata?.calcom_booking_id;
    const outcome = determineOutcome(call, call, callAnalysis, customAnalysis, duration, bookingId);

    try {
      const { recordMetric } = require('../../utils/metrics');
      recordMetric('total_calls', 1, 'counter');
    } catch (err) {
      logger.error('[retell] Failed to record metric:', err.message);
    }

    // Track usage for billing
    try { const { trackUsage } = require('../../utils/usageTracker'); trackUsage(db, clientId, 'call'); } catch (_) {}

    const sentiment = callAnalysis.user_sentiment || 'neutral';

    await db.query(`
      UPDATE calls SET
        duration = ?,
        outcome = ?,
        summary = ?,
        score = ?,
        sentiment = ?,
        transcript = ?,
        updated_at = ?
      WHERE call_id = ?
    `, [duration, outcome, summary, score, sentiment, transcriptText, new Date().toISOString(), callId], 'run');

    try {
      const { broadcast } = require('../../utils/websocket');
      broadcast('new_call', { id: callId, phone: callRecord.caller_phone, status: outcome, duration, score, summary });
    } catch (err) {
      logger.warn('[retell] WebSocket broadcast error:', err.message);
    }

    try {
      const { emitAnalyticsEvent } = require('../../utils/analyticsStream');
      emitAnalyticsEvent({
        type: 'call_completed',
        data: { callId, phone: callRecord.caller_phone, outcome, duration, score },
        clientId: callRecord.client_id,
      });
    } catch (_) { /* non-fatal */ }

    return { summary, score, outcome, sentiment, duration, bookingId, transcriptText };
  } catch (err) {
    logger.error(`[retell] analyzeCallConversation error for ${callId}:`, { correlationId, error: err.message, stack: err.stack });
    throw err;
  }
}

/**
 * Run post-call actions: upsert lead, send owner notifications (SMS/Telegram),
 * and trigger autonomous brain decisions.
 */
async function generateAndSendNotifications(db, callRecord, callData, call, analysis, correlationId) {
  const callId = call.call_id;
  const { summary, score, outcome, sentiment, duration, bookingId } = analysis;
  const callerPhone = callRecord.caller_phone;
  const clientId = callRecord.client_id;
  try {
    await processLeadFromCall(db, { callRecord, callId, outcome, summary, score, sentiment, duration, bookingId });
    await notifyOwnerOfCall(db, clientId, callId, outcome, summary);
  } catch (err) {
    logger.error(`[retell] generateAndSendNotifications error for ${callId}:`, { correlationId, error: err.message, stack: err.stack });
    throw err;
  }

  // BRAIN — autonomous post-call decisions (non-fatal if it fails)
  if (callerPhone && clientId) {
    try {
      const { getLeadMemory } = require('../../utils/leadMemory');
      const { think } = require('../../utils/brain');
      const { executeActions } = require('../../utils/actionExecutor');
      const memory = getLeadMemory(db, callerPhone, clientId);
      if (memory) {
        const decision = await think('call_ended', { call_id: callId, duration, outcome, summary, score }, memory, db);
        await executeActions(db, decision.actions, memory);
      }
    } catch (brainErr) {
      logger.error('[Brain] Post-call error:', { correlationId, error: brainErr.message });
    }
  }
}

async function handleCallEnded(db, call, correlationId) {
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] call_ended missing call or call_id', { correlationId });
      return;
    }
    const callId = call.call_id;
    logger.info(`[retell] call_ended: ${callId}`, { correlationId });

    if (await checkCallProcessed(db, callId, correlationId)) return;

    const fetched = await fetchCallDataFromRetell(db, call, correlationId);
    if (!fetched) return;

    const { callData, callRecord } = fetched;
    const analysis = await analyzeCallConversation(db, callRecord, callData, call, correlationId);
    await generateAndSendNotifications(db, callRecord, callData, call, analysis, correlationId);

    logger.info(`[retell] call_ended processed: ${callId} outcome=${analysis.outcome} score=${analysis.score}`, { correlationId });
  } catch (err) {
    logger.error('[retell] call_ended error:', { correlationId, error: err.message, stack: err.stack });
  }
}

async function handleCallAnalyzed(db, call) {
  try {
    if (!call || !call.call_id) {
      logger.warn('[retell] call_analyzed missing call or call_id');
      return;
    }
    const callId = call.call_id;
    const analysis = call.call_analysis || {};

    const rawTranscript = call.transcript || '';
    const transcriptText = typeof rawTranscript === 'string'
      ? rawTranscript
      : Array.isArray(rawTranscript)
        ? rawTranscript.map(t => `${t.role}: ${t.content}`).join('\n')
        : JSON.stringify(rawTranscript);

    const callSummary = analysis.call_summary || '';

    await db.query(`
      UPDATE calls SET
        transcript = CASE WHEN (transcript IS NULL OR transcript = '') AND ? != '' THEN ? ELSE transcript END,
        summary = CASE WHEN (summary IS NULL OR summary = '' OR summary = 'Summary unavailable' OR summary = 'Call too short for summary') AND ? != '' THEN ? ELSE summary END,
        sentiment = COALESCE(?, sentiment),
        analysis_data = ?,
        updated_at = ?
      WHERE call_id = ?
    `, [
      transcriptText, transcriptText,
      callSummary, callSummary,
      analysis.user_sentiment || null,
      JSON.stringify(analysis),
      new Date().toISOString(),
      callId
    ], 'run');

    logger.info(`[retell] call_analyzed: ${callId} transcript=${transcriptText.length}chars summary=${callSummary.length}chars`);
  } catch (err) {
    logger.error('[retell] call_analyzed error:', err);
  }
}

module.exports = {
  handleCallStarted,
  handleCallEnded,
  handleCallAnalyzed,
};
