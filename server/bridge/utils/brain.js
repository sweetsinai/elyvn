/**
 * ELYVN Brain — Autonomous Decision Engine
 *
 * Takes any event + full lead memory, calls Claude, returns actions.
 * Uses sync better-sqlite3 for guardrails checks.
 */

const { BRAIN_LOCK_TIMEOUT_MS, CIRCUIT_BREAKER_FAILURE_WINDOW_MS, CIRCUIT_BREAKER_COOLDOWN_MS } = require('../config/timing');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const config = require('./config');
const fs = require('fs');
const path = require('path');
const { CircuitBreaker } = require('./resilience');
const { logger } = require('./logger');

const anthropic = new Anthropic();

// Circuit breaker for Claude API — opens after 5 failures in 60s, cools down 30s
const claudeBreaker = new CircuitBreaker(
  async (params) => anthropic.messages.create(params),
  { failureThreshold: 5, failureWindow: CIRCUIT_BREAKER_FAILURE_WINDOW_MS, cooldownPeriod: CIRCUIT_BREAKER_COOLDOWN_MS, serviceName: 'Claude-Brain' }
);

// Per-lead lock to prevent concurrent brain decisions on the same lead
const leadLocks = new Map();

/**
 * Strip characters that could be used for prompt injection before interpolating
 * user-controlled data into a prompt string.
 */
function sanitizeForPrompt(str, maxLen = 200) {
  if (!str) return '';
  return String(str).replace(/[\r\n\t]/g, ' ').replace(/[<>{}]/g, '').substring(0, maxLen);
}

/**
 * Rough token estimate: ~4 characters per token (GPT/Claude heuristic).
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * @param {string} eventType - call_ended | sms_received | form_submitted | followup_due | no_response_timeout | daily_review
 * @param {object} eventData - Raw event payload
 * @param {object} leadMemory - Output of getLeadMemory()
 * @param {object} db - better-sqlite3 instance (for guardrails)
 * @returns {Promise<{reasoning: string, actions: object[]}>}
 */
async function think(eventType, eventData, leadMemory, db) {
  const { lead, client, timeline, insights } = leadMemory;

  // Per-lead token-based lock: serialize brain decisions for the same lead.
  // Each acquisition gets a unique token; unlock only releases if the caller
  // still holds the current token, preventing timeout-forced releases from
  // unlocking a legitimate holder that acquired the lock afterward.
  const lockKey = lead?.id;
  if (lockKey) {
    const LOCK_TIMEOUT_MS = BRAIN_LOCK_TIMEOUT_MS;
    if (leadLocks.has(lockKey)) {
      const existingLock = leadLocks.get(lockKey);
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Brain lock timeout for lead ${lockKey} after ${LOCK_TIMEOUT_MS}ms`)), LOCK_TIMEOUT_MS)
      );
      try {
        await Promise.race([existingLock.promise, timeout]);
      } catch (err) {
        logger.error(`[Brain] ${err.message} — forcing lock release`);
        // Only delete if the token hasn't changed (no new holder snuck in)
        const current = leadLocks.get(lockKey);
        if (current && current.token === existingLock.token) {
          leadLocks.delete(lockKey);
        }
      }
    }
    const myToken = crypto.randomUUID();
    let unlock;
    const promise = new Promise(resolve => { unlock = resolve; });
    leadLocks.set(lockKey, { token: myToken, promise });
    try {
      return await _think(eventType, eventData, leadMemory, db);
    } finally {
      // Only release if we still own the lock
      const current = leadLocks.get(lockKey);
      if (current && current.token === myToken) {
        leadLocks.delete(lockKey);
        unlock();
      }
    }
  }
  return _think(eventType, eventData, leadMemory, db);
}

async function _think(eventType, eventData, leadMemory, db) {
  const { lead, client, timeline, insights } = leadMemory;

  // Load knowledge base (capped at 5000 chars to avoid Claude token overflow)
  const MAX_KB_SIZE = 5000;
  let knowledgeBase = '';
  if (client) {
    try {
      const { loadKnowledgeBase } = require('./kbCache');
      const raw = await loadKnowledgeBase(client.id);
      if (raw) {
        const kbData = JSON.parse(raw);
        knowledgeBase = typeof kbData === 'string' ? kbData : JSON.stringify(kbData, null, 2);
        if (knowledgeBase.length > MAX_KB_SIZE) {
          knowledgeBase = knowledgeBase.substring(0, MAX_KB_SIZE) + '\n[...truncated]';
        }
      }
    } catch (_) {}
  }

  // Guardrails
  const guardrails = checkGuardrails(db, lead, client);

  const safeBusinessName = sanitizeForPrompt(client?.business_name) || 'the business';
  const safeClientName   = sanitizeForPrompt(client?.business_name) || 'Unknown';
  const safeOwnerName    = sanitizeForPrompt(client?.owner_name) || 'Unknown';

  const systemPrompt = `You are the ELYVN Brain — an autonomous AI operations engine for "${safeBusinessName}".

YOUR ROLE: After every event, analyze the full lead history and decide what actions to take next. Think across ALL channels.

BUSINESS KNOWLEDGE BASE:
${knowledgeBase || 'No knowledge base loaded.'}

CLIENT: ${safeClientName} | Owner: ${safeOwnerName} | AI active: ${client?.is_active !== 0 ? 'YES' : 'NO — only notify owner'}
Calendar: ${client?.calcom_booking_link || 'Not configured'}

RULES:
1. Max 3 follow-up touches per lead unless they re-engage
2. If lead already booked — only appointment reminders, no sales follow-ups
3. If transferred to owner — do NOT auto-follow-up, owner is handling it
4. If AI paused — only notify_owner allowed
5. Escalate: complaints, legal mentions, human requests, out-of-KB questions
6. Time-sensitive availability questions → follow up within 2 hours
7. Reference prior interactions naturally
8. When composing SMS, reference SPECIFIC details from the TIMELINE: mention what they asked about, the service discussed, or their name. Never send generic "just checking in". Example: if they called about brake pads, say "Hi Sarah, following up on the brake pad quote we discussed."
9. Never reveal you are AI
10. High-intent leads (score >= 7) not booked → recommend owner calls them
11. Keep SMS under 160 chars

${guardrails.length > 0 ? '\nACTIVE GUARDRAILS (MUST obey):\n' + guardrails.map(g => '- ' + g).join('\n') : ''}

AVAILABLE ACTIONS (return as JSON array):
- { "action": "send_sms", "to": "+1...", "message": "..." }
- { "action": "schedule_followup", "delay_hours": N, "message": "..." }
- { "action": "cancel_pending_followups", "reason": "..." }
- { "action": "update_lead_stage", "stage": "new|contacted|warm|hot|booked|lost|nurture" }
- { "action": "update_lead_score", "score": N, "reason": "..." }
- { "action": "book_appointment", "start_time": "ISO datetime", "service": "...", "email": "...", "phone": "+1..." }
- { "action": "notify_owner", "message": "...", "urgency": "low|medium|high|critical" }
- { "action": "log_insight", "insight": "..." }
- { "action": "no_action", "reason": "..." }

RESPOND WITH ONLY a JSON object (no markdown):
{ "reasoning": "2-3 sentences", "actions": [ ... ] }`;

  const safeLeadName  = sanitizeForPrompt(lead?.name) || 'Unknown';
  const safeLeadPhone = sanitizeForPrompt(lead?.phone);

  function buildTimelineText(sliceCount) {
    const entries = timeline.slice(-sliceCount).map(t => {
      if (t.type === 'call') return `[${t.timestamp}] CALL: ${sanitizeForPrompt(t.summary, 300)} (score: ${t.score}, outcome: ${sanitizeForPrompt(t.outcome, 50)})`;
      if (t.type === 'message') return `[${t.timestamp}] ${t.direction === 'inbound' ? 'SMS IN' : 'SMS OUT'}: "${sanitizeForPrompt(t.body || t.reply || '', 100)}"`;
      if (t.type === 'followup_sent') return `[${t.timestamp}] FOLLOWUP #${t.touch}: "${sanitizeForPrompt(t.content || '', 80)}"`;
      return `[${t.timestamp}] ${t.type}`;
    });
    return entries.length > 0 ? entries.join('\n') : 'No previous interactions.';
  }

  function buildUserMessage(timelineText) {
    return `EVENT: ${eventType}
EVENT DATA: ${JSON.stringify(eventData, null, 2)}

LEAD: ${lead ? `${safeLeadName} (${safeLeadPhone}) — Score: ${lead.score || 0}/10 — Stage: ${lead.stage}` : 'New lead'}

TIMELINE:
${timelineText}

INSIGHTS:
- Interactions: ${insights.totalInteractions} (${insights.totalCalls} calls, ${insights.totalMessages} msgs)
- Booked: ${insights.hasBooked ? 'YES' : 'NO'}
- Transferred to owner: ${insights.hasBeenTransferred ? 'YES' : 'NO'}
- Pending follow-ups: ${insights.pendingFollowups}
- Days since last contact: ${insights.daysSinceLastContact ?? 'first contact'}
- High intent: ${insights.highIntent ? 'YES' : 'NO'}
- Slipping away: ${insights.slippingAway ? 'YES' : 'NO'}
- Multi-channel: ${insights.multiChannel ? 'YES' : 'NO'}

What actions should ELYVN take?`;
  }

  let userMessage = buildUserMessage(buildTimelineText(15));

  // Token guard: if estimated usage exceeds 6000 tokens, trim timeline and KB
  if (estimateTokens(systemPrompt) + estimateTokens(userMessage) > 6000) {
    logger.warn('[Brain] Prompt too large — trimming timeline to 8 entries and KB to 2500 chars');
    if (knowledgeBase.length > 2500) {
      knowledgeBase = knowledgeBase.substring(0, 2500) + '\n[...truncated]';
    }
    userMessage = buildUserMessage(buildTimelineText(8));
  }

  try {
    const response = await claudeBreaker.call({
      model: config.ai.model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const cleaned = text.replace(/```json|```/g, '').trim();
    let decision;
    try {
      decision = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('[Brain] JSON parse failed:', parseErr.message);
      return {
        reasoning: 'Brain parse error — unreadable response',
        actions: [{ action: 'notify_owner', message: 'Brain returned unparseable response for ' + eventType, urgency: 'high' }],
      };
    }

    // Validate actions
    if (decision.actions && Array.isArray(decision.actions)) {
      const { isValidAction, isValidStage, VALID_ACTIONS } = require('./validate');
      decision.actions = decision.actions.filter(a => {
        if (!a.action || !isValidAction(a.action)) {
          logger.warn(`[Brain] Filtered invalid action type: ${a.action}. Valid: ${VALID_ACTIONS.join(', ')}`);
          return false;
        }
        // Validate stage in update_lead_stage
        if (a.action === 'update_lead_stage' && a.stage && !isValidStage(a.stage)) {
          logger.warn(`[Brain] Invalid stage "${a.stage}" — filtering out`);
          return false;
        }
        // Validate score range
        if (a.action === 'update_lead_score' && (typeof a.score !== 'number' || a.score < 0 || a.score > 10)) {
          logger.warn(`[Brain] Invalid score ${a.score} — filtering out`);
          return false;
        }
        return true;
      });
    }

    logger.info(`[Brain] ${lead?.phone || '?'}: ${decision.reasoning}`);
    logger.info(`[Brain] Actions: ${decision.actions.map(a => a.action).join(', ')}`);

    return decision;
  } catch (error) {
    logger.error('[Brain] Error:', error.message);
    return {
      reasoning: 'Brain error — fallback to owner notification',
      actions: [{
        action: 'notify_owner',
        message: `Brain error on ${eventType} for ${lead?.phone || '?'}: ${error.message}`,
        urgency: 'medium',
      }],
    };
  }
}

function checkGuardrails(db, lead, client) {
  const warnings = [];
  if (!lead?.id || !client?.id) return warnings;

  try {
    // Max 3 brain-initiated SMS per 24h
    const recentSMS = db.prepare(
      `SELECT COUNT(*) as c FROM messages
       WHERE phone = ? AND client_id = ? AND direction = 'outbound' AND reply_source = 'brain'
       AND created_at > datetime('now', '-24 hours')`
    ).get(lead.phone, client.id);
    if (recentSMS && recentSMS.c >= 3) {
      warnings.push('RATE_LIMIT: 3 brain SMS sent in 24h. Do NOT send_sms.');
    }

    // Owner took over via transfer (check most recent call only)
    const lastCall = db.prepare(
      `SELECT outcome FROM calls WHERE caller_phone = ? AND client_id = ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(lead.phone, client.id);
    if (lastCall && lastCall.outcome === 'transferred') {
      warnings.push('OWNER_HANDLING: Lead was most recently transferred to owner. Only notify_owner, no send_sms or schedule_followup.');
    }

    // Opt-out signals
    const optOut = db.prepare(
      `SELECT 1 FROM messages WHERE phone = ? AND client_id = ? AND direction = 'inbound'
       AND (LOWER(body) LIKE '%stop%' OR LOWER(body) LIKE '%unsubscribe%' OR LOWER(body) LIKE '%opt out%')
       ORDER BY created_at DESC LIMIT 1`
    ).get(lead.phone, client.id);
    if (optOut) {
      warnings.push('OPT_OUT: Lead may have opted out. Do NOT send_sms. Only notify_owner.');
    }
  } catch (err) {
    logger.error('[Brain] Guardrail check error:', err.message);
  }

  return warnings;
}

module.exports = { think, _claudeBreaker: claudeBreaker, _leadLocks: leadLocks };
