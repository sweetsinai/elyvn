const telegram = require('../telegram');
const { logger } = require('../logger');

async function sendDailySummaries(db) {
  const startTime = Date.now();
  const clients = await db.query(
    'SELECT * FROM clients WHERE telegram_chat_id IS NOT NULL AND is_active = 1'
  );

  logger.info(`[dailySummary] START — processing ${clients.length} clients`);

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const client of clients) {
    const calls = await db.query(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
      FROM calls WHERE client_id = ? AND date(created_at) = ?`,
      [client.id, today], 'get'
    );

    const msgs = await db.query(
      `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND date(created_at) = ?`,
      [client.id, today], 'get'
    );

    const rev = await db.query(
      `SELECT COALESCE(COUNT(*) * ?, 0) as revenue FROM calls WHERE client_id = ? AND outcome = 'booked' AND date(created_at) = ?`,
      [client.avg_ticket || 0, client.id, today], 'get'
    );

    const tomorrowSchedule = await db.query(
      `SELECT id, client_id, phone, name, service, datetime, status FROM appointments WHERE client_id = ? AND date(datetime) = ? AND status = 'confirmed' ORDER BY datetime ASC`,
      [client.id, tomorrow]
    );

    const stats = {
      total_calls: calls.total || 0,
      booked: calls.booked || 0,
      missed: calls.missed || 0,
      messages: msgs.total || 0,
      revenue: rev.revenue || 0,
    };

    // KB learning suggestions — surface common unanswered topics
    let kbSuggestion = '';
    try {
      const { extractCommonTopics } = require('../conversationIntelligence');
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const topics = await extractCommonTopics(db, client.id, weekAgo);
      if (topics && topics.length > 0) {
        const { loadKnowledgeBase } = require('../kbCache');
        let kbText = '';
        try {
          kbText = (await loadKnowledgeBase(client.id)).toLowerCase();
        } catch (_) {}
        const missing = topics.filter(t => t.frequency >= 3 && !kbText.includes(t.topic.toLowerCase()));
        if (missing.length > 0) {
          kbSuggestion = '\n\n<b>FAQ suggestions:</b>\n' +
            missing.slice(0, 3).map(t => `${t.frequency} customers asked about <b>${t.topic}</b> this week`).join('\n');
        }
      }
    } catch (err) {
      logger.error(`[Scheduler] KB suggestion error for ${client.id}:`, err.message);
    }

    const formatted = telegram.formatDailySummary(stats, tomorrowSchedule, client);
    telegram.sendMessage(client.telegram_chat_id, formatted.text + kbSuggestion).catch(err =>
      logger.error(`Daily summary failed for client ${client.id}:`, err)
    );
  }

  logger.info(`[dailySummary] DONE — processed ${clients.length} clients, duration ${Date.now() - startTime}ms`);
}

module.exports = { sendDailySummaries };
