'use strict';

/**
 * ELYVN Multi-Agent System — Anthropic Managed Agents
 *
 * Specialized agents that collaborate on lead management:
 *   - Receptionist: handles events, decides next actions
 *   - Qualification: scores leads
 *   - Scheduling: manages follow-ups and appointments
 *
 * Each agent is created once (agent ID cached), environments are shared,
 * and sessions are per-task (short-lived).
 */

const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('../logger');
const config = require('../config');
const { sanitizeForPrompt } = require('../brain');

const client = new Anthropic();

// ─── Agent registry (agent_id → created agent metadata) ─────────────────────
const _agents = new Map();
const _environments = new Map();

// ─── Agent definitions ──────────────────────────────────────────────────────

const AGENT_DEFINITIONS = {
  receptionist: {
    name: 'ELYVN Receptionist',
    model: config.ai.model,
    description: 'Autonomous AI operations engine. Analyzes events and decides actions across all channels.',
    instructions: `You are the ELYVN Receptionist Brain — an autonomous AI operations engine for service businesses.

YOUR ROLE: After every event (call, SMS, form submission), analyze the full lead history and decide what actions to take next.

RULES:
1. Max 3 follow-up touches per lead unless they re-engage
2. If lead already booked — only appointment reminders, no sales follow-ups
3. If transferred to owner — do NOT auto-follow-up
4. If AI paused — only notify_owner allowed
5. Escalate: complaints, legal mentions, human requests
6. Keep SMS under 160 chars
7. Never reveal you are AI
8. Reference specific details from conversation history

RESPOND WITH ONLY a JSON object:
{ "reasoning": "2-3 sentences", "actions": [ ... ] }`,
  },

  qualification: {
    name: 'ELYVN Qualifier',
    model: config.ai.model,
    description: 'Lead scoring agent.',
    instructions: `You are a lead qualification expert. You perform lead scoring:
Given lead interaction history, score 1-10 on intent to buy.
Return: { "score": N, "factors": [...], "recommended_action": "..." }

Always return valid JSON. Be conservative — only score high if there's clear buying intent.`,
  },

  scheduling: {
    name: 'ELYVN Scheduler',
    model: config.ai.model,
    description: 'Follow-up timing and appointment optimization agent.',
    instructions: `You are a scheduling optimization expert for service businesses.

YOUR ROLE: Given a lead's history, determine the optimal follow-up timing and channel.

CONSIDER:
- Business hours (9 AM - 6 PM local time)
- Day of week (Tuesday-Thursday are best)
- Lead's response patterns (when did they last engage?)
- Channel preference (if they called, follow up by phone; if texted, follow up by SMS)
- Urgency (hot leads need same-day follow-up)

RESPOND WITH JSON:
{ "delay_hours": N, "channel": "sms|call", "reasoning": "...", "suggested_message": "..." }`,
  },
};

// ─── Environment creation ───────────────────────────────────────────────────

/**
 * Get or create a cloud environment for agent execution.
 * Environments are reused across sessions.
 */
async function getOrCreateEnvironment(name = 'elyvn-prod') {
  if (_environments.has(name)) return _environments.get(name);

  try {
    const env = await client.beta.environments.create({
      name,
      config: {
        type: 'cloud',
        networking: { type: 'restricted' }, // No outbound network for safety
      },
    });
    _environments.set(name, env.id);
    logger.info(`[agents] Environment created: ${name} (${env.id})`);
    return env.id;
  } catch (err) {
    logger.error(`[agents] Failed to create environment ${name}:`, err.message);
    throw err;
  }
}

// ─── Agent creation ─────────────────────────────────────────────────────────

/**
 * Get or create a named agent. Agent IDs are cached in memory.
 * In production, these should be created once and stored in env vars.
 */
async function getOrCreateAgent(type) {
  // Check env var first (pre-provisioned agents)
  const envKey = `AGENT_ID_${type.toUpperCase()}`;
  if (process.env[envKey]) {
    return process.env[envKey];
  }

  if (_agents.has(type)) return _agents.get(type);

  const def = AGENT_DEFINITIONS[type];
  if (!def) throw new Error(`Unknown agent type: ${type}`);

  try {
    const agent = await client.beta.agents.create({
      name: def.name,
      model: def.model,
      instructions: def.instructions,
      tools: [], // No sandboxed tools — we handle tool execution server-side
    });
    _agents.set(type, agent.id);
    logger.info(`[agents] Agent created: ${type} (${agent.id})`);
    return agent.id;
  } catch (err) {
    logger.error(`[agents] Failed to create agent ${type}:`, err.message);
    throw err;
  }
}

// ─── Session execution ──────────────────────────────────────────────────────

/**
 * Run a single-turn agent task: create session, send message, collect response.
 *
 * @param {string} agentType - 'receptionist' | 'qualification' | 'scheduling'
 * @param {string} userMessage - The task prompt
 * @param {object} [options] - Optional overrides
 * @param {string} [options.systemOverride] - Override the agent's default instructions
 * @param {number} [options.timeoutMs=30000] - Max wait time
 * @returns {Promise<{text: string, parsed: object|null, usage: object}>}
 */
async function runAgent(agentType, userMessage, options = {}) {
  const { systemOverride, timeoutMs = 30000 } = options;
  const startTime = Date.now();

  try {
    const agentId = await getOrCreateAgent(agentType);
    const environmentId = await getOrCreateEnvironment();

    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      ...(systemOverride ? { instructions: systemOverride } : {}),
    });

    // Send message
    await client.beta.sessions.events.send(session.id, {
      events: [{
        type: 'user.message',
        content: [{ type: 'text', text: userMessage }],
      }],
    });

    // Collect response with timeout
    const stream = await client.beta.sessions.events.stream(session.id);
    let responseText = '';
    const deadline = Date.now() + timeoutMs;

    for await (const event of stream) {
      if (Date.now() > deadline) {
        logger.warn(`[agents] ${agentType} session timed out after ${timeoutMs}ms`);
        break;
      }
      if (event.type === 'agent.message') {
        for (const block of (event.content || [])) {
          if (block.type === 'text') responseText += block.text;
        }
      } else if (event.type === 'session.status_idle' || event.type === 'session.ended') {
        break;
      }
    }

    const elapsed = Date.now() - startTime;
    logger.debug(`[agents] ${agentType} completed in ${elapsed}ms (${responseText.length} chars)`);

    // Try to parse JSON from response
    let parsed = null;
    try {
      const cleaned = responseText.replace(/```json\s*|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // Not JSON — that's fine for some agents
    }

    return { text: responseText, parsed, elapsed };

  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`[agents] ${agentType} failed after ${elapsed}ms:`, err.message);
    throw err;
  }
}

// ─── Convenience methods for each agent type ────────────────────────────────

/**
 * Run the receptionist brain on an event.
 * Falls back to the existing brain.js if managed agents API is unavailable.
 */
async function receptionistDecide(context) {
  const { client: bizClient, lead, eventType, eventData, timeline, insights, knowledgeBase, guardrails } = context;

  const safeEventData = JSON.stringify(eventData).substring(0, 2000).replace(/Human:|Assistant:|SYSTEM:/gi, '');
  const safeName = sanitizeForPrompt(lead?.name, 100) || 'Unknown';
  const safePhone = sanitizeForPrompt(lead?.phone, 20);
  const safeBizName = sanitizeForPrompt(bizClient?.business_name, 100) || 'Unknown';
  const safeOwner = sanitizeForPrompt(bizClient?.owner_name, 100) || 'Unknown';
  const safeTimeline = (timeline || []).slice(-15).map(t => {
    const safeSummary = sanitizeForPrompt(t.summary || t.body || t.content || '', 100);
    return `[${t.timestamp}] ${t.type}: ${safeSummary}`;
  }).join('\n') || 'No history';

  const userMessage = `EVENT: ${eventType}
EVENT DATA: ${safeEventData}

LEAD: ${lead ? `${safeName} (${safePhone}) — Score: ${lead.score || 0}/10 — Stage: ${lead.stage}` : 'New lead'}

BUSINESS: ${safeBizName} | Owner: ${safeOwner}
Calendar: ${bizClient?.calcom_booking_link || 'Not configured'}

KNOWLEDGE BASE:
${(knowledgeBase || '').substring(0, 2000)}

TIMELINE (last 15 interactions):
${safeTimeline}

INSIGHTS:
- Total interactions: ${insights?.totalInteractions || 0}
- Has booked: ${insights?.hasBooked ? 'YES' : 'NO'}
- Pending follow-ups: ${insights?.pendingFollowups || 0}
- Days since last contact: ${insights?.daysSinceLastContact ?? 'first contact'}
- High intent: ${insights?.highIntent ? 'YES' : 'NO'}

${guardrails?.length > 0 ? 'ACTIVE GUARDRAILS:\n' + guardrails.map(g => '- ' + g).join('\n') : ''}

What actions should ELYVN take?`;

  return runAgent('receptionist', userMessage);
}

/**
 * Determine optimal follow-up timing for a lead.
 */
async function scheduleOptimize(lead, interactions) {
  const userMessage = `Determine the optimal follow-up for this lead:

LEAD: ${sanitizeForPrompt(lead.name, 100) || 'Unknown'} — Stage: ${lead.stage} — Score: ${lead.score || 0}/10
Phone: ${sanitizeForPrompt(lead.phone, 20)}

RECENT INTERACTIONS:
${(interactions || []).slice(-10).map(i => `[${i.timestamp}] ${i.type}: ${sanitizeForPrompt(i.summary || i.body || '', 80)}`).join('\n') || 'None'}

Current time: ${new Date().toISOString()}

Return JSON: { "delay_hours": N, "channel": "sms|call", "reasoning": "...", "suggested_message": "..." }`;

  return runAgent('scheduling', userMessage);
}

// ─── Health check ───────────────────────────────────────────────────────────

function getAgentHealth() {
  return {
    agents_cached: _agents.size,
    environments_cached: _environments.size,
    agent_types: Array.from(_agents.keys()),
    definitions: Object.keys(AGENT_DEFINITIONS),
  };
}

module.exports = {
  runAgent,
  receptionistDecide,
  scheduleOptimize,
  getOrCreateAgent,
  getOrCreateEnvironment,
  getAgentHealth,
  AGENT_DEFINITIONS,
};
