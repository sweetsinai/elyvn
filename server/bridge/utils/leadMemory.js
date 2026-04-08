/**
 * Lead Memory — builds a complete picture of any lead across all channels.
 * The brain reads this before making any decision.
 */
const { randomUUID } = require('crypto');
const { normalizePhone } = require('./phone');

async function getLeadMemory(db, phone, clientId) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || !clientId) return null;

  // 1. Get or create lead (INSERT ON CONFLICT to prevent TOCTOU race)
  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO leads (id, client_id, phone, score, stage, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'new', datetime('now'), datetime('now'))
       ON CONFLICT(client_id, phone) DO NOTHING`,
      [id, clientId, normalizedPhone], 'run'
    );
  } catch (err) {
    // FK constraint fails if client doesn't exist — continue to lookup
  }

  let lead = await db.query(
    'SELECT * FROM leads WHERE phone = ? AND client_id = ?',
    [normalizedPhone, clientId], 'get'
  );

  // 2. All calls from this number
  const calls = await db.query(
    `SELECT id, direction, duration, transcript, summary, sentiment, score, outcome, created_at
     FROM calls WHERE caller_phone = ? AND client_id = ? ORDER BY created_at DESC LIMIT 20`,
    [normalizedPhone, clientId]
  );

  // 3. All messages
  const messages = await db.query(
    `SELECT id, channel, direction, body, reply_text, status, confidence, created_at
     FROM messages WHERE phone = ? AND client_id = ? ORDER BY created_at DESC LIMIT 30`,
    [normalizedPhone, clientId]
  );

  // 4. All follow-ups
  const followups = lead ? await db.query(
    `SELECT id, touch_number, type, content, scheduled_at, sent_at, status
     FROM followups WHERE lead_id = ? ORDER BY scheduled_at DESC LIMIT 20`,
    [lead.id]
  ) : [];

  // 5. Client record
  const client = await db.query('SELECT * FROM clients WHERE id = ?', [clientId], 'get');

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
  const hasBooked = lead ? (lead.stage === 'booked' || !!lead.calcom_booking_id) : false;
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
      highIntent: (lead?.score || 0) >= 7,
      slippingAway: daysSinceLastContact !== null && daysSinceLastContact >= 2 && !hasBooked,
      multiChannel: calls.length > 0 && messages.length > 0,
    },
  };
}

module.exports = { getLeadMemory };
