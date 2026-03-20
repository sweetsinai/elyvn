const telegram = require('./telegram');

function sendDailySummaries(db) {
  const clients = db.prepare(
    'SELECT * FROM clients WHERE telegram_chat_id IS NOT NULL AND is_active = 1'
  ).all();

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const client of clients) {
    const calls = db.prepare(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
      FROM calls WHERE client_id = ? AND date(created_at) = ?`
    ).get(client.id, today);

    const msgs = db.prepare(
      `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND date(created_at) = ?`
    ).get(client.id, today);

    const rev = db.prepare(
      `SELECT COALESCE(SUM(estimated_revenue), 0) as revenue FROM calls WHERE client_id = ? AND outcome = 'booked' AND date(created_at) = ?`
    ).get(client.id, today);

    const tomorrowSchedule = db.prepare(
      `SELECT * FROM calls WHERE client_id = ? AND outcome = 'booked' AND date(created_at) = ? ORDER BY created_at ASC`
    ).all(client.id, tomorrow);

    const stats = {
      total_calls: calls.total || 0,
      booked: calls.booked || 0,
      missed: calls.missed || 0,
      messages: msgs.total || 0,
      revenue: rev.revenue || 0,
    };

    const formatted = telegram.formatDailySummary(stats, tomorrowSchedule, client);
    telegram.sendMessage(client.telegram_chat_id, formatted.text).catch(err =>
      console.error(`Daily summary failed for client ${client.id}:`, err)
    );
  }
}

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
      `SELECT COALESCE(SUM(estimated_revenue), 0) as revenue FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?`
    ).get(client.id, since);

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
      console.error(`Weekly report failed for client ${client.id}:`, err)
    );
  }
}

function initScheduler(db) {
  // Daily summary at 7 PM
  const now = new Date();
  const daily = new Date(now);
  daily.setHours(19, 0, 0, 0);
  if (daily <= now) daily.setDate(daily.getDate() + 1);
  const dailyDelay = daily.getTime() - now.getTime();

  setTimeout(() => {
    console.log('[Scheduler] Sending daily summaries');
    sendDailySummaries(db);
    setInterval(() => {
      console.log('[Scheduler] Sending daily summaries');
      sendDailySummaries(db);
    }, 24 * 60 * 60 * 1000);
  }, dailyDelay);

  console.log(`[Scheduler] Daily summary scheduled in ${Math.round(dailyDelay / 1000 / 60)} minutes (7 PM)`);

  // Weekly report Monday 8 AM
  const weekly = new Date(now);
  const dayOfWeek = weekly.getDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 && now.getHours() < 8 ? 0 : 8 - dayOfWeek;
  weekly.setDate(weekly.getDate() + daysUntilMonday);
  weekly.setHours(8, 0, 0, 0);
  if (weekly <= now) weekly.setDate(weekly.getDate() + 7);
  const weeklyDelay = weekly.getTime() - now.getTime();

  setTimeout(() => {
    console.log('[Scheduler] Sending weekly reports');
    sendWeeklyReports(db);
    setInterval(() => {
      console.log('[Scheduler] Sending weekly reports');
      sendWeeklyReports(db);
    }, 7 * 24 * 60 * 60 * 1000);
  }, weeklyDelay);

  console.log(`[Scheduler] Weekly report scheduled in ${Math.round(weeklyDelay / 1000 / 60 / 60)} hours (Monday 8 AM)`);
}

module.exports = { initScheduler, sendDailySummaries, sendWeeklyReports };
