const telegram = require('../telegram');
const { logger } = require('../logger');

function sendWeeklyReports(db) {
  const clients = db.prepare(
    'SELECT * FROM clients WHERE telegram_chat_id IS NOT NULL AND is_active = 1'
  ).all();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const client of clients) {
    const calls = db.prepare(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
      FROM calls WHERE client_id = ? AND created_at >= ?`
    ).get(client.id, since);

    const msgs = db.prepare(
      `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND created_at >= ?`
    ).get(client.id, since);

    const rev = db.prepare(
      `SELECT COALESCE(COUNT(*) * ?, 0) as revenue FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?`
    ).get(client.avg_ticket || 0, client.id, since);

    const totalCalls = calls.total || 0;
    const missed = calls.missed || 0;
    const missedRate = totalCalls > 0 ? Math.round((missed / totalCalls) * 100) : 0;

    const report = {
      total_calls: totalCalls,
      booked: calls.booked || 0,
      missed,
      messages: msgs.total || 0,
      revenue: rev.revenue || 0,
      missed_rate: missedRate,
      ai_summary: null,
    };

    // Persist to weekly_reports table
    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekEnd = new Date().toISOString().split('T')[0];
    const reportId = `wr-${client.id}-${weekEnd}`;
    db.prepare(
      `INSERT OR REPLACE INTO weekly_reports (id, client_id, week_start, week_end, calls_answered, appointments_booked, messages_handled, estimated_revenue, missed_call_rate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(reportId, client.id, weekStart, weekEnd, report.total_calls, report.booked, report.messages, report.revenue, report.missed_rate / 100);

    const formatted = telegram.formatWeeklyReport(report, client);
    telegram.sendMessage(client.telegram_chat_id, formatted.text).catch(err =>
      logger.error(`Weekly report failed for client ${client.id}:`, err)
    );
  }
}

module.exports = { sendWeeklyReports };
