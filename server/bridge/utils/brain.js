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

// Token bucket rate limiter for Claude API calls
const BRAIN_MAX_QPS = 10;
let brainTokens = BRAIN_MAX_QPS;
setInterval(() => { brainTokens = Math.min(BRAIN_MAX_QPS, brainTokens + BRAIN_MAX_QPS); }, 1000);

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
  return String(str)
    .replace(/\x00/g, '')                                    // strip null bytes
    .replace(/[\r\n\t]/g, ' ')
    .replace(/<[a-z_/][^>]*>/gi, '')                         // strip all XML/HTML tags
    .replace(/[{}]/g, '')
    .replace(/Human:|Assistant:|SYSTEM:|---{3,}/gi, '')      // Claude delimiters
    .replace(/\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>/gi, '') // Llama delimiters
    .replace(/```[\s\S]*?```/g, ' ')                         // code fences
    .replace(/\s{2,}/g, ' ')
    .trim()
    .substring(0, maxLen);
}

/**
 * Recursively sanitize all string values in an object/array so that nested
 * eventData fields cannot carry prompt injection via inner string values.
 * Non-string primitives are passed through unchanged.
 */
function deepSanitizeEventData(value, depth = 0) {
  if (depth > 10) return '[truncated]'; // guard against deeply nested objects
  if (typeof value === 'string') return sanitizeForPrompt(value, 500);
  if (Array.isArray(value)) return value.map(v => deepSanitizeEventData(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const sanitized = {};
    for (const [k, v] of Object.entries(value)) {
      sanitized[k] = deepSanitizeEventData(v, depth + 1);
    }
    return sanitized;
  }
  return value;
}

/**
 * Rough token estimate: ~4 characters per token (GPT/Claude heuristic).
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Load and format knowledge base for a client (shared by legacy and multi-agent paths).
 */
async function _loadKnowledgeBase(client) {
  const MAX_KB_SIZE = 5000;
  if (!client) return '';
  try {
    const { loadKnowledgeBase } = require('./kbCache');
    const raw = await loadKnowledgeBase(client.id);
    if (!raw) return '';
    const kbData = JSON.parse(raw);
    let kb = '';
    if (typeof kbData === 'object' && kbData !== null) {
      const parts = [];
      if (kbData.business_name) parts.push(`Business: ${kbData.business_name}`);
      if (kbData.services?.length) parts.push(`Services: ${kbData.services.join(', ')}`);
      if (kbData.business_hours) parts.push(`Hours: ${kbData.business_hours}`);
      if (kbData.booking_info) parts.push(`Booking: ${kbData.booking_info}`);
      if (kbData.faq?.length) {
        parts.push('FAQ:');
        kbData.faq.forEach(f => parts.push(`Q: ${f.question}\nA: ${f.answer}`));
      }
      if (kbData.escalation_phrases?.length) parts.push(`Escalate on: ${kbData.escalation_phrases.join(', ')}`);
      kb = parts.join('\n');
    } else {
      kb = typeof kbData === 'string' ? kbData : JSON.stringify(kbData);
    }
    return kb.length > MAX_KB_SIZE ? kb.substring(0, MAX_KB_SIZE) + '\n[...truncated]' : kb;
  } catch (err) {
    logger.warn(`[brain] KB load failed for client ${client.id}:`, err.message);
    return '';
  }
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

  // ── Multi-agent path (opt-in via ELYVN_MANAGED_AGENTS=true) ──
  try {
    const { isEnabled, newLeadPipeline } = require('./agents/orchestrator');
    if (isEnabled()) {
      const knowledgeBase = await _loadKnowledgeBase(client);
      const guardrails = await checkGuardrails(db, lead, client);
      const result = await newLeadPipeline({
        db, client, lead, eventType, eventData, timeline, insights, knowledgeBase, guardrails,
      });
      if (result && result.decision) {
        logger.info('[Brain] Multi-agent pipeline returned decision');
        return result.decision;
      }
      // If pipeline returns null, fall through to legacy single-call path
    }
  } catch (agentErr) {
    logger.warn('[Brain] Multi-agent pipeline failed, falling through to legacy:', agentErr.message);
  }

  // Load knowledge base (capped at 5000 chars to avoid Claude token overflow)
  const MAX_KB_SIZE = 5000;
  let knowledgeBase = '';
  if (client) {
    try {
      const { loadKnowledgeBase } = require('./kbCache');
      const raw = await loadKnowledgeBase(client.id);
      if (raw) {
        const kbData = JSON.parse(raw);
        // Convert JSON to concise text format (saves ~30% tokens vs raw JSON)
        if (typeof kbData === 'object' && kbData !== null) {
          const parts = [];
          if (kbData.business_name) parts.push(`Business: ${kbData.business_name}`);
          if (kbData.services?.length) parts.push(`Services: ${kbData.services.join(', ')}`);
          if (kbData.business_hours) parts.push(`Hours: ${kbData.business_hours}`);
          if (kbData.booking_info) parts.push(`Booking: ${kbData.booking_info}`);
          if (kbData.faq?.length) {
            parts.push('FAQ:');
            kbData.faq.forEach(f => parts.push(`Q: ${f.question}\nA: ${f.answer}`));
          }
          if (kbData.escalation_phrases?.length) parts.push(`Escalate on: ${kbData.escalation_phrases.join(', ')}`);
          knowledgeBase = parts.join('\n');
        } else {
          knowledgeBase = typeof kbData === 'string' ? kbData : JSON.stringify(kbData);
        }
        if (knowledgeBase.length > MAX_KB_SIZE) {
          knowledgeBase = knowledgeBase.substring(0, MAX_KB_SIZE) + '\n[...truncated]';
        }
      }
    } catch (kbErr) {
      logger.warn(`[brain] KB load failed for client ${client.id}:`, kbErr.message);
    }
  }

  // Guardrails
  const guardrails = await checkGuardrails(db, lead, client);

  // Fetch conversation intelligence for client performance context (FIX 4)
  let perfContext = '';
  try {
    if (client?.id) {
      const { getConversationIntelligence } = require('./conversationIntelligence');
      const intel = await getConversationIntelligence(db, client.id, 30);
      if (intel && intel.summary) {
        const bookingRate = intel.summary.booking_rate || '0%';
        const avgDuration = intel.summary.avg_call_duration_seconds
          ? Math.round(intel.summary.avg_call_duration_seconds / 60) : 0;
        const peakHourStr = (intel.peak_hours && intel.peak_hours.length > 0)
          ? `${intel.peak_hours[0].day} ${intel.peak_hours[0].hour}:00` : 'unknown';
        perfContext = `\nCLIENT PERFORMANCE CONTEXT:\n${bookingRate} of calls convert to bookings. Average call duration: ${avgDuration} minutes. Peak hour: ${peakHourStr}. Use this context when making decisions.\n`;
      }
    }
  } catch (_) {
    // Conversation intelligence unavailable — proceed without it
  }

  const safeBusinessName = sanitizeForPrompt(client?.business_name) || 'the business';
  const safeClientName   = sanitizeForPrompt(client?.business_name) || 'Unknown';
  const safeOwnerName    = sanitizeForPrompt(client?.owner_name) || 'Unknown';

  const systemPrompt = `You are the ELYVN Brain — an autonomous AI operations engine for "${safeBusinessName}".

YOUR ROLE: After every event, analyze the full lead history and decide what actions to take next. Think across ALL channels.

BUSINESS KNOWLEDGE BASE:
${sanitizeForPrompt(knowledgeBase, 2000) || 'No knowledge base loaded.'}

CLIENT: ${safeClientName} | Owner: ${safeOwnerName} | AI active: ${client?.is_active !== 0 ? 'YES' : 'NO — only notify owner'}
Calendar: ${client?.calcom_booking_link || 'Not configured'}
${perfContext}
GROUNDING REQUIREMENT:
You MUST only use facts explicitly provided in the TIMELINE, lead data, EVENT DATA, or BUSINESS KNOWLEDGE BASE above. Never invent dates, statistics, previous interactions, prices, service details, or specific details not present in the provided context. If a fact is not in the context, do not state it.

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
${guardrails.some(g => g.includes('RATE_LIMIT')) ? '- send_sms is DISABLED (daily limit reached)' : '- { "action": "send_sms", "to": "+1...", "message": "..." }'}
${guardrails.some(g => g.includes('OWNER_HANDLING')) ? '- schedule_followup is DISABLED (owner handling)' : '- { "action": "schedule_followup", "delay_hours": N, "message": "..." }'}
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
    const sanitizedEventData = JSON.stringify(deepSanitizeEventData(eventData), null, 2).substring(0, 2000);
    return `EVENT: ${eventType}
EVENT DATA: ${sanitizedEventData}

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
    const { recordMetric } = require('./metrics');

    // Rate limit check: bail out if too many concurrent decisions
    if (brainTokens <= 0) {
      logger.warn('[Brain] Rate limited — too many concurrent decisions');
      return {
        reasoning: 'Brain rate limited — deferring to owner notification',
        actions: [{ action: 'notify_owner', message: `Brain rate limited for ${eventType} on ${lead?.phone || '?'}`, urgency: 'low' }],
      };
    }
    brainTokens--;

    const brainStart = Date.now();

    const PROMPT_VERSION = 'brain-v2';

    const response = await claudeBreaker.call({
      model: config.ai.model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [{
        name: 'decide_actions',
        description: 'Return the brain decision with reasoning and actions to execute.',
        input_schema: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: '2-3 sentences explaining the decision' },
            actions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['send_sms', 'schedule_followup', 'cancel_pending_followups', 'update_lead_stage', 'update_lead_score', 'book_appointment', 'notify_owner', 'log_insight', 'no_action'] },
                },
                required: ['action'],
              },
            },
          },
          required: ['reasoning', 'actions'],
        },
      }],
      tool_choice: { type: 'tool', name: 'decide_actions' },
    });

    recordMetric('brain_decision_time_ms', Date.now() - brainStart, 'histogram');

    // Track AI decision usage for billing
    try { const { trackUsage } = require('./usageTracker'); trackUsage(db, leadMemory?.clientId, 'ai_decision'); } catch (_) {}

    // Extract structured tool_use response (guaranteed JSON via tool_choice)
    let decision = null;
    const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'decide_actions');
    const textBlock = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    if (toolBlock?.input) {
      decision = toolBlock.input;
    }

    // Audit trail with prompt version
    try {
      if (lead?.id) {
        const { appendEvent, Events } = require('./eventStore');
        await appendEvent(db, lead.id, 'lead', Events.BrainReasoningCaptured, {
          prompt_version: PROMPT_VERSION,
          prompt_preview: systemPrompt.substring(0, 500),
          response: JSON.stringify(decision || textBlock),
          model: config.ai.model || 'claude-unknown',
          event_type: eventType,
        }, client?.id || null);
      }
    } catch (_) {}

    // Fallback: parse text response if tool_use not returned
    if (!decision) {
      try {
        const cleaned = (textBlock || '').replace(/```json|```/g, '').trim();
        decision = JSON.parse(cleaned);
      } catch (parseErr) {
        logger.error('[Brain] JSON parse failed (no tool_use block):', parseErr.message);
        return {
        reasoning: 'Brain parse error — unreadable response',
        actions: [{ action: 'notify_owner', message: 'Brain returned unparseable response for ' + eventType, urgency: 'high' }],
      };
    }

    // Validate actions
    if (decision.actions && Array.isArray(decision.actions)) {
      const { isValidAction, isValidStage, VALID_ACTIONS } = require('./validate');
      const { validateBrainAction } = require('./groundingEnforcer');
      const { recordMetric } = require('./metrics');

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

        // Grounding enforcement: validate action against actual timeline/lead data
        const grounding = validateBrainAction(a, timeline, lead, knowledgeBase);
        if (!grounding.valid) {
          logger.warn(`[Brain] Grounding violation for ${a.action}: ${grounding.violations.join('; ')}`);
          recordMetric('brain_grounding_violations', 1, 'counter');
          return false;
        }

        return true;
      });
    }

    logger.info(`[Brain] ${lead?.phone || '?'}: ${decision.reasoning}`);
    logger.info(`[Brain] Actions: ${decision.actions.map(a => a.action).join(', ')}`);

    return decision;
    }  // end if (!decision)
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

async function checkGuardrails(db, lead, client) {
  const warnings = [];
  if (!lead?.id || !client?.id) return warnings;

  try {
    // Max 3 brain-initiated SMS per 24h
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentSMS = await db.query(
      `SELECT COUNT(*) as c FROM messages
       WHERE phone = ? AND client_id = ? AND direction = 'outbound' AND reply_source = 'brain'
       AND created_at > ?`,
      [lead.phone, client.id, twentyFourHoursAgo], 'get'
    );
    if (recentSMS && recentSMS.c >= 3) {
      warnings.push('RATE_LIMIT: 3 brain SMS sent in 24h. Do NOT send_sms.');
    }

    // Owner took over via transfer (check most recent call only)
    const lastCall = await db.query(
      `SELECT outcome FROM calls WHERE caller_phone = ? AND client_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [lead.phone, client.id], 'get'
    );
    if (lastCall && lastCall.outcome === 'transferred') {
      warnings.push('OWNER_HANDLING: Lead was most recently transferred to owner. Only notify_owner, no send_sms or schedule_followup.');
    }

    // Opt-out signals
    const optOut = await db.query(
      `SELECT 1 FROM messages WHERE phone = ? AND client_id = ? AND direction = 'inbound'
       AND (LOWER(body) LIKE '%stop%' OR LOWER(body) LIKE '%unsubscribe%' OR LOWER(body) LIKE '%opt out%')
       ORDER BY created_at DESC LIMIT 1`,
      [lead.phone, client.id], 'get'
    );
    if (optOut) {
      warnings.push('OPT_OUT: Lead may have opted out. Do NOT send_sms. Only notify_owner.');
    }
  } catch (err) {
    logger.error('[Brain] Guardrail check error:', err.message);
  }

  return warnings;
}

function _resetForTesting() {
  brainTokens = BRAIN_MAX_QPS;
  claudeBreaker.reset();
  leadLocks.clear();
}

module.exports = { think, sanitizeForPrompt, _claudeBreaker: claudeBreaker, _leadLocks: leadLocks, _resetForTesting };
