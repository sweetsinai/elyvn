'use strict';

/**
 * Multi-Agent Orchestrator
 *
 * Coordinates workflows that span multiple agents:
 *   - New lead pipeline: qualify → receptionist → schedule
 *
 * Falls back to existing single-call utils if managed agents API
 * is unavailable (graceful degradation).
 */

const { logger } = require('../logger');
const { receptionistDecide, scheduleOptimize } = require('./index');

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
 * Check if multi-agent system is enabled and healthy.
 */
function isEnabled() {
  return AGENTS_ENABLED;
}

module.exports = {
  newLeadPipeline,
  isEnabled,
};
