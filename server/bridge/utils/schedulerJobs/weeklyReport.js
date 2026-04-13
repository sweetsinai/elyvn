const telegram = require('../telegram');
const { logger } = require('../logger');
const Anthropic = require('@anthropic-ai/sdk');
const { CircuitBreaker } = require('../resilience');

// Shared circuit breaker for Claude weekly report calls
const weeklyAIBreaker = new CircuitBreaker(
  async (prompt, model) => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20000 });
    return anthropic.messages.create({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
  },
  {
    failureThreshold: 3,
    failureWindow: 60000,
    cooldownPeriod: 30000,
    serviceName: 'Anthropic-WeeklyReport',
    fallback: () => null,
  }
);

/**
 * Generate an AI-written weekly business intelligence report for a client.
 * Uses Claude to turn raw stats into a human-friendly, actionable summary.
 */
async function generateAISummary(client, report, topLeads) {
  try {

    const topLeadsList = topLeads.slice(0, 3).map(l =>
      `- ${l.name || 'Unknown'} (score ${l.score}/100, stage: ${l.stage})`
    ).join('\n') || '- No hot leads this week';

    const prompt = `You are an AI business assistant writing a concise weekly report for a small business owner.

Business: ${client.business_name || client.name}
Industry: ${client.industry || 'service business'}

This week's stats:
- Total calls handled: ${report.total_calls}
- Appointments booked: ${report.booked}
- Missed calls: ${report.missed} (${report.missed_rate}% miss rate)
- SMS conversations: ${report.messages}
- Estimated revenue from bookings: $${(report.revenue || 0).toFixed(0)}
- Revenue closed (confirmed jobs): $${(report.revenue_closed || 0).toFixed(0)}

Top leads right now:
${topLeadsList}

Write a 3-sentence business intelligence summary. Be direct and specific:
1. What went well this week (or didn't)
2. One specific action the owner should take TODAY based on the data
3. One forward-looking insight

No fluff. No greetings. No sign-offs. Just the 3 sentences.`;

    const response = await weeklyAIBreaker.call(prompt, process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514');
    return response?.content?.[0]?.text?.trim() || null;
  } catch (err) {
    logger.warn('[weeklyReport] AI summary generation failed:', err.message);
    return null;
  }
}

async function sendWeeklyReports(db) {
  const clients = await db.query(
    'SELECT id, business_name, industry, avg_ticket, telegram_chat_id, plan FROM clients WHERE telegram_chat_id IS NOT NULL AND is_active = 1 LIMIT 500',
    [], 'all'
  );

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const client of clients) {
    try {
      // Fetch all stats in parallel
      const [calls, msgs, rev, closedRev, topLeads] = await Promise.all([
        db.query(
          `SELECT COUNT(*) as total,
            SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
            SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed
          FROM calls WHERE client_id = ? AND created_at >= ?`,
          [client.id, since], 'get'
        ),
        db.query(
          `SELECT COUNT(*) as total FROM messages WHERE client_id = ? AND created_at >= ?`,
          [client.id, since], 'get'
        ),
        db.query(
          `SELECT COALESCE(COUNT(*) * ?, 0) as revenue FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?`,
          [client.avg_ticket || 0, client.id, since], 'get'
        ),
        db.query(
          `SELECT COALESCE(SUM(revenue_closed), 0) as total FROM leads WHERE client_id = ? AND updated_at >= ?`,
          [client.id, since], 'get'
        ),
        db.query(
          `SELECT name, score, stage FROM leads WHERE client_id = ? AND score >= 65 ORDER BY score DESC LIMIT 5`,
          [client.id], 'all'
        ),
      ]);

      const totalCalls = calls.total || 0;
      const missed = calls.missed || 0;
      const missedRate = totalCalls > 0 ? Math.round((missed / totalCalls) * 100) : 0;

      const report = {
        total_calls: totalCalls,
        booked: calls.booked || 0,
        missed,
        messages: msgs.total || 0,
        revenue: rev.revenue || 0,
        revenue_closed: closedRev.total || 0,
        missed_rate: missedRate,
        ai_summary: null,
      };

      // Generate AI summary (non-blocking — failure is fine)
      report.ai_summary = await generateAISummary(client, report, topLeads || []);

      // Persist to weekly_reports table
      const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const weekEnd = new Date().toISOString().split('T')[0];
      const reportId = `wr-${client.id}-${weekEnd}`;
      await db.query(
        `INSERT OR REPLACE INTO weekly_reports (id, client_id, week_start, week_end, calls_answered, appointments_booked, messages_handled, estimated_revenue, missed_call_rate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [reportId, client.id, weekStart, weekEnd, report.total_calls, report.booked, report.messages, report.revenue, report.missed_rate / 100, new Date().toISOString()], 'run'
      );

      // Format and send to Telegram
      const formatted = telegram.formatWeeklyReport(report, client);
      let text = formatted.text;

      // Append hot leads if any (AI summary is already in formatWeeklyReport output)
      if (topLeads && topLeads.length > 0) {
        const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        text += `\n\n&#128293; <b>Hot Leads to Call:</b>\n` +
          topLeads.slice(0, 3).map(l => `• ${esc(l.name || 'Unknown')} — score ${l.score}/100`).join('\n');
      }

      await telegram.sendMessage(client.telegram_chat_id, text);

      // Record metric
      try {
        const { recordMetric } = require('../metrics');
        recordMetric('weekly_reports_sent', 1);
      } catch (_) {}
    } catch (err) {
      logger.error(`[weeklyReport] Failed for client ${client.id}:`, err.message);
    }
  }
}

module.exports = { sendWeeklyReports };
