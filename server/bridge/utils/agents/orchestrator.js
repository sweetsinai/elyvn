'use strict';

/**
 * Multi-Agent Orchestrator
 *
 * Coordinates workflows that span multiple agents:
 *   - New lead pipeline: qualify → receptionist → schedule
 *   - Email reply pipeline: qualify → receptionist
 *   - Outreach pipeline: outreach → qualify (self-review)
 *
 * Falls back to existing single-call utils if managed agents API
 * is unavailable (graceful degradation).
 */

const { logger } = require('../logger');
const { receptionistDecide, outreachCompose, qualifyReply, scheduleOptimize, runAgent } = require('./index');

// Feature flag — enable managed agents only when explicitly opted in
const AGENTS_ENABLED = process.env.ELYVN_MANAGED_AGENTS === 'true';

/**
 * Pipeline: New lead event
 * 1. Receptionist decides actions
 * 2. If follow-up needed → Scheduling agent optimizes timing
 *
 * @param {object} context - { db, client, lead, eventType, eventData, timeline, insights, knowledgeBase, guardrails }
 * @returns {Promise<{decision: object, schedule: object|null}>}
 */
async function newLeadPipeline(context) {
  if (!AGENTS_ENABLED) return null; // Caller uses legacy brain.js

  const startTime = Date.now();
  logger.info(`[orchestrator] New lead pipeline started for ${context.eventType}`);

  // Step 1: Receptionist decides what to do
  const decision = await receptionistDecide(context);
  if (!decision.parsed) {
    logger.warn('[orchestrator] Receptionist returned non-JSON — falling back');
    return null;
  }

  // Step 2: If there's a follow-up action, optimize its timing
  let schedule = null;
  const followupAction = (decision.parsed.actions || []).find(
    a => a.action === 'schedule_followup' || a.action === 'send_sms'
  );

  if (followupAction && context.lead) {
    try {
      schedule = await scheduleOptimize(context.lead, context.timeline);
      if (schedule.parsed) {
        // Merge scheduling agent's recommendation into the follow-up action
        if (schedule.parsed.delay_hours !== undefined) {
          followupAction.delay_hours = schedule.parsed.delay_hours;
        }
        if (schedule.parsed.channel) {
          followupAction.optimized_channel = schedule.parsed.channel;
        }
        if (schedule.parsed.suggested_message && followupAction.action === 'send_sms') {
          followupAction.suggested_alternative = schedule.parsed.suggested_message;
        }
      }
    } catch (err) {
      logger.warn('[orchestrator] Scheduling agent failed (non-fatal):', err.message);
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[orchestrator] New lead pipeline completed in ${elapsed}ms`);

  return { decision: decision.parsed, schedule: schedule?.parsed || null };
}

/**
 * Pipeline: Email reply received
 * 1. Qualification agent classifies the reply
 * 2. Receptionist decides next action based on classification
 *
 * @param {object} context - { db, client, lead, subject, body, timeline, insights, knowledgeBase, guardrails }
 * @returns {Promise<{classification: object, decision: object}>}
 */
async function replyPipeline(context) {
  if (!AGENTS_ENABLED) return null;

  const startTime = Date.now();
  logger.info('[orchestrator] Reply pipeline started');

  // Step 1: Classify the reply
  const classification = await qualifyReply(context.subject, context.body);

  // Step 2: Feed classification into receptionist as enriched event
  const enrichedContext = {
    ...context,
    eventType: 'email_reply_classified',
    eventData: {
      original_subject: (context.subject || '').substring(0, 200),
      original_body: (context.body || '').substring(0, 500),
      classification: classification.parsed || { classification: 'QUESTION', confidence: 0 },
    },
  };

  const decision = await receptionistDecide(enrichedContext);

  const elapsed = Date.now() - startTime;
  logger.info(`[orchestrator] Reply pipeline completed in ${elapsed}ms`);

  return {
    classification: classification.parsed,
    decision: decision.parsed,
  };
}

/**
 * Pipeline: Cold email outreach
 * 1. Outreach agent composes email
 * 2. Qualification agent reviews for quality (self-check)
 *
 * @param {object} prospect - Prospect data
 * @param {object} bizClient - Client/business data
 * @returns {Promise<{email: object, review: object}>}
 */
async function outreachPipeline(prospect, bizClient) {
  if (!AGENTS_ENABLED) return null;

  const startTime = Date.now();
  logger.info(`[orchestrator] Outreach pipeline started for ${prospect.business_name}`);

  // Step 1: Compose the email
  const emailResult = await outreachCompose(prospect, bizClient);
  if (!emailResult.parsed || !emailResult.parsed.body) {
    logger.warn('[orchestrator] Outreach agent returned invalid email');
    return null;
  }

  // Step 2: Self-review — qualification agent checks the email quality
  let review = null;
  try {
    const reviewResult = await runAgent('qualification', `Review this cold email for quality. Is it professional, personalized, and likely to get a response? Rate 1-10.

SUBJECT A: ${emailResult.parsed.subject_a || ''}
SUBJECT B: ${emailResult.parsed.subject_b || ''}
BODY: ${emailResult.parsed.body}

Return JSON: { "score": N, "issues": ["..."], "approved": true/false }`);
    review = reviewResult.parsed;
  } catch (err) {
    logger.warn('[orchestrator] Email self-review failed (non-fatal):', err.message);
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[orchestrator] Outreach pipeline completed in ${elapsed}ms — review score: ${review?.score || 'N/A'}`);

  return {
    email: emailResult.parsed,
    review,
    approved: review ? review.approved !== false : true,
  };
}

/**
 * Pipeline: Lead scoring with multi-signal analysis
 * 1. Qualification agent analyzes all signals
 * 2. Scheduling agent recommends optimal next touch
 *
 * @param {object} lead - Lead data
 * @param {Array} interactions - Recent interactions
 * @returns {Promise<{score: object, schedule: object}>}
 */
async function scoringPipeline(lead, interactions) {
  if (!AGENTS_ENABLED) return null;

  const startTime = Date.now();

  // Run qualification and scheduling in parallel
  const [scoreResult, schedResult] = await Promise.all([
    runAgent('qualification', `Score this lead on intent to buy (1-10):

LEAD: ${lead.name || 'Unknown'} — Current stage: ${lead.stage}
Phone: ${lead.phone}

INTERACTIONS:
${(interactions || []).slice(-15).map(i => `[${i.timestamp}] ${i.type}: ${(i.summary || i.body || '').substring(0, 100)}`).join('\n') || 'None'}

Return JSON: { "score": N, "factors": ["reason1", "reason2"], "recommended_action": "..." }`),
    scheduleOptimize(lead, interactions),
  ]);

  const elapsed = Date.now() - startTime;
  logger.info(`[orchestrator] Scoring pipeline completed in ${elapsed}ms`);

  return {
    score: scoreResult.parsed,
    schedule: schedResult.parsed,
  };
}

/**
 * Check if multi-agent system is enabled and healthy.
 */
function isEnabled() {
  return AGENTS_ENABLED;
}

module.exports = {
  newLeadPipeline,
  replyPipeline,
  outreachPipeline,
  scoringPipeline,
  isEnabled,
};
