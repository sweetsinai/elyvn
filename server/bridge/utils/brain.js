/**
 * ELYVN Brain — Autonomous Decision Engine
 *
 * Takes any event + full lead memory, calls Claude, returns actions.
 * Uses sync better-sqlite3 for guardrails checks.
 */
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const anthropic = new Anthropic();

/**
 * @param {string} eventType - call_ended | sms_received | form_submitted | followup_due | no_response_timeout | daily_review
 * @param {object} eventData - Raw event payload
 * @param {object} leadMemory - Output of getLeadMemory()
 * @param {object} db - better-sqlite3 instance (for guardrails)
 * @returns {Promise<{reasoning: string, actions: object[]}>}
 */
async function think(eventType, eventData, leadMemory, db) {
  const { lead, client, timeline, insights } = leadMemory;

  // Load knowledge base (capped at 5000 chars to avoid Claude token overflow)
  const MAX_KB_SIZE = 5000;
  let knowledgeBase = '';
  if (client) {
    try {
      const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${client.id}.json`);
      const kbData = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
      knowledgeBase = typeof kbData === 'string' ? kbData : JSON.stringify(kbData, null, 2);
      if (knowledgeBase.length > MAX_KB_SIZE) {
        knowledgeBase = knowledgeBase.substring(0, MAX_KB_SIZE) + '\n[...truncated]';
      }
    } catch (_) {}
  }

  // Guardrails
  const guardrails = checkGuardrails(db, lead, client);

  const systemPrompt = `You are the ELYVN Brain — an autonomous AI operations engine for "${client?.business_name || 'the business'}".

YOUR ROLE: After every event, analyze the full lead history and decide what actions to take next. Think across ALL channels.

BUSINESS KNOWLEDGE BASE:
${knowledgeBase || 'No knowledge base loaded.'}

CLIENT: ${client?.business_name || 'Unknown'} | Owner: ${client?.owner_name || 'Unknown'} | AI active: ${client?.is_active !== 0 ? 'YES' : 'NO — only notify owner'}
Calendar: ${client?.calcom_booking_link || 'Not configured'}

RULES:
1. Max 3 follow-up touches per lead unless they re-engage
2. If lead already booked — only appointment reminders, no sales follow-ups
3. If transferred to owner — do NOT auto-follow-up, owner is handling it
4. If AI paused — only notify_owner allowed
5. Escalate: complaints, legal mentions, human requests, out-of-KB questions
6. Time-sensitive availability questions → follow up within 2 hours
7. Reference prior interactions naturally
8. Never reveal you are AI
9. High-intent leads (score >= 7) not booked → recommend owner calls them
10. Keep SMS under 160 chars

${guardrails.length > 0 ? '\nACTIVE GUARDRAILS (MUST obey):\n' + guardrails.map(g => '- ' + g).join('\n') : ''}

AVAILABLE ACTIONS (return as JSON array):
- { "action": "send_sms", "to": "+1...", "message": "..." }
- { "action": "schedule_followup", "delay_hours": N, "message": "..." }
- { "action": "cancel_pending_followups", "reason": "..." }
- { "action": "update_lead_stage", "stage": "new|contacted|warm|hot|booked|lost|nurture" }
- { "action": "update_lead_score", "score": N, "reason": "..." }
- { "action": "notify_owner", "message": "...", "urgency": "low|medium|high|critical" }
- { "action": "log_insight", "insight": "..." }
- { "action": "no_action", "reason": "..." }

RESPOND WITH ONLY a JSON object (no markdown):
{ "reasoning": "2-3 sentences", "actions": [ ... ] }`;

  const timelineText = timeline.length > 0
    ? timeline.slice(-15).map(t => {
        if (t.type === 'call') return `[${t.timestamp}] CALL: ${t.summary} (score: ${t.score}, outcome: ${t.outcome})`;
        if (t.type === 'message') return `[${t.timestamp}] ${t.direction === 'inbound' ? 'SMS IN' : 'SMS OUT'}: "${(t.body || t.reply || '').substring(0, 100)}"`;
        if (t.type === 'followup_sent') return `[${t.timestamp}] FOLLOWUP #${t.touch}: "${(t.content || '').substring(0, 80)}"`;
        return `[${t.timestamp}] ${t.type}`;
      }).join('\n')
    : 'No previous interactions.';

  const userMessage = `EVENT: ${eventType}
EVENT DATA: ${JSON.stringify(eventData, null, 2)}

LEAD: ${lead ? `${lead.name || 'Unknown'} (${lead.phone}) — Score: ${lead.score || 0}/10 — Stage: ${lead.stage}` : 'New lead'}

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

  try {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const cleaned = text.replace(/```json|```/g, '').trim();
    const decision = JSON.parse(cleaned);

    console.log(`[Brain] ${lead?.phone || '?'}: ${decision.reasoning}`);
    console.log(`[Brain] Actions: ${decision.actions.map(a => a.action).join(', ')}`);

    return decision;
  } catch (error) {
    console.error('[Brain] Error:', error.message);
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

    // Owner took over via transfer
    const transferred = db.prepare(
      `SELECT 1 FROM calls WHERE caller_phone = ? AND client_id = ? AND outcome = 'transferred'
       ORDER BY created_at DESC LIMIT 1`
    ).get(lead.phone, client.id);
    if (transferred) {
      warnings.push('OWNER_HANDLING: Lead was transferred to owner. Only notify_owner, no send_sms or schedule_followup.');
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
    console.error('[Brain] Guardrail check error:', err.message);
  }

  return warnings;
}

module.exports = { think };
