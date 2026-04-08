'use strict';

/**
 * brain.js — AI/LLM helpers for call analysis
 *
 * Owns: Anthropic client, circuit breaker, transcript fetch,
 *       summary generation, lead scoring, outcome determination.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { CircuitBreaker } = require('../../utils/resilience');
const { addTraceHeaders } = require('../../utils/tracing');
const { AppError } = require('../../utils/AppError');
const { logger } = require('../../utils/logger');
const config = require('../../utils/config');

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_BASE = 'https://api.retellai.com/v2';

const anthropic = new Anthropic();

// Circuit breaker for Retell REST API
const retellBreaker = new CircuitBreaker(
  async (url, opts) => {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
    if (!resp.ok) throw new AppError('UPSTREAM_ERROR', `Retell API ${resp.status}`, 502);
    return resp;
  },
  {
    failureThreshold: 3, failureWindow: 60000, cooldownPeriod: 30000, serviceName: 'Retell',
    fallback: () => ({ error: 'Service temporarily unavailable', fallback: true }),
  }
);

// Circuit breaker for Anthropic messages API
const anthropicBreaker = new CircuitBreaker(
  async (params) => anthropic.messages.create(params),
  {
    failureThreshold: 5, failureWindow: 60000, cooldownPeriod: 30000, serviceName: 'Anthropic',
    fallback: () => ({
      content: [{ text: "I'm sorry, I'm having trouble right now. Please call back in a few minutes." }],
      fallback: true,
    }),
  }
);

async function fetchCallTranscript(callId) {
  if (!RETELL_API_KEY) {
    logger.warn('[retell] No RETELL_API_KEY — using webhook payload data only');
    return {};
  }
  try {
    const retellResp = await retellBreaker.call(`${RETELL_BASE}/get-call/${callId}`, {
      headers: addTraceHeaders({ 'Authorization': `Bearer ${RETELL_API_KEY}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (retellResp && retellResp.fallback) {
      logger.warn(`[retell] Retell circuit breaker fallback for ${callId}`);
      return {};
    }
    return await retellResp.json();
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
    const summaryResp = await anthropicBreaker.call({
      model: config.ai.model,
      max_tokens: 150,
      messages: [{ role: 'user', content: hasTranscript
        ? `Summarize this phone call transcript in exactly 2 lines. Be specific about what was discussed and any outcomes:\n\n${transcriptText}`
        : `Rewrite this call summary in 2 clear lines for a business owner:\n\n${analysisSummary}` }]
    });
    if (summaryResp.fallback) {
      logger.warn('[retell] Anthropic circuit breaker fallback for summary generation');
      return analysisSummary || 'Summary unavailable';
    }
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
    const scoreResp = await anthropicBreaker.call({
      model: config.ai.model,
      max_tokens: 10,
      messages: [{ role: 'user', content: `Score this lead 1-10 based on their interest, urgency, and qualification from this call ${hasTranscript ? 'transcript' : 'summary'}. Reply with ONLY a single number:\n\n${scoringText}` }]
    });
    if (scoreResp.fallback) {
      logger.warn('[retell] Anthropic circuit breaker fallback for lead scoring');
      return 5;
    }
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

module.exports = {
  retellBreaker,
  anthropicBreaker,
  fetchCallTranscript,
  generateCallSummary,
  scoreCall,
  generateCallSummaryAndScore,
  determineOutcome,
};
