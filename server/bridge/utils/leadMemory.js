/**
 * Lead Memory — builds a complete picture of any lead across all channels.
 * The brain reads this before making any decision.
 */
const { randomUUID } = require('crypto');

function getLeadMemory(db, phone, clientId) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || !clientId) return null;

  // 1. Get or create lead
  let lead = db.prepare(
    'SELECT * FROM leads WHERE phone = ? AND client_id = ?'
  ).get(normalizedPhone, clientId);

  if (!lead) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO leads (id, client_id, phone, score, stage, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'new', datetime('now'), datetime('now'))`
    ).run(id, clientId, normalizedPhone);
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  }

  // 2. All calls from this number
  const calls = db.prepare(
    `SELECT id, direction, duration, transcript, summary, sentiment, score, outcome, created_at
     FROM calls WHERE caller_phone = ? AND client_id = ? ORDER BY created_at DESC LIMIT 20`
  ).all(normalizedPhone, clientId);

  // 3. All messages
  const messages = db.prepare(
    `SELECT id, channel, direction, body, reply_text, status, confidence, created_at
     FROM messages WHERE phone = ? AND client_id = ? ORDER BY created_at DESC LIMIT 30`
  ).all(normalizedPhone, clientId);

  // 4. All follow-ups
  const followups = lead ? db.prepare(
    `SELECT id, touch_number, type, content, scheduled_at, sent_at, status
     FROM followups WHERE lead_id = ? ORDER BY scheduled_at DESC LIMIT 20`
  ).all(lead.id) : [];

  // 5. Client record
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);

  // 6. Build timeline (chronological, all channels merged)
  const timeline = [
    ...calls.map(c => ({
      type: 'call',
      timestamp: c.created_at,
      summary: c.summary || `${Math.floor((c.duration || 0) / 60)}m${(c.duration || 0) % 60}s call, outcome: ${c.outcome}`,
      outcome: c.outcome,
      score: c.score,
      duration: c.duration,
    })),
    ...messages.map(m => ({
      type: 'message',
      timestamp: m.created_at,
      direction: m.direction,
      body: m.body,
      reply: m.reply_text,
      confidence: m.confidence,
    })),
    ...followups.filter(f => f.sent_at).map(f => ({
      type: 'followup_sent',
      timestamp: f.sent_at,
      touch: f.touch_number,
      content: f.content,
    })),
  ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // 7. Derived insights
  const lastInteraction = timeline.length > 0 ? timeline[timeline.length - 1] : null;
  const hasBooked = lead.stage === 'booked' || !!lead.calcom_booking_id;
  const hasBeenTransferred = calls.some(c => c.outcome === 'transferred');
  const pendingFollowups = followups.filter(f => f.status === 'scheduled');
  const daysSinceLastContact = lastInteraction
    ? Math.floor((Date.now() - new Date(lastInteraction.timestamp).getTime()) / 86400000)
    : null;

  return {
    lead,
    client,
    calls,
    messages,
    followups,
    timeline,
    insights: {
      totalCalls: calls.length,
      totalMessages: messages.length,
      totalInteractions: calls.length + messages.length,
      lastInteraction,
      hasBooked,
      hasBeenTransferred,
      pendingFollowups: pendingFollowups.length,
      daysSinceLastContact,
      highIntent: (lead.score || 0) >= 7,
      slippingAway: daysSinceLastContact !== null && daysSinceLastContact >= 2 && !hasBooked,
      multiChannel: calls.length > 0 && messages.length > 0,
    },
  };
}

function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = String(phone).replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (!cleaned.startsWith('+')) return '+' + cleaned;
  return cleaned;
}

module.exports = { getLeadMemory, normalizePhone };
