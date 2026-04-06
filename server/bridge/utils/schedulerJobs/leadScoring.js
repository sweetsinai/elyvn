const telegram = require('../telegram');
const { logger } = require('../logger');

async function dailyLeadScoring(db) {
  try {
    const { batchScoreLeads } = require('../leadScoring');
    const clients = db.prepare('SELECT id, telegram_chat_id FROM clients WHERE is_active = 1').all();

    for (const client of clients) {
      try {
        const scores = batchScoreLeads(db, client.id);
        const hotLeads = scores.filter(s => s.predictive_score >= 75);

        // Update lead scores in the DB based on predictive model
        for (const s of scores) {
          // Map 0-100 predictive score to 0-10 lead score
          const newScore = Math.round(s.predictive_score / 10);
          db.prepare('UPDATE leads SET score = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(newScore, s.leadId);
        }

        // Notify owner of hot leads
        if (hotLeads.length > 0 && client.telegram_chat_id) {
          const topLeads = hotLeads.slice(0, 5).map(l =>
            `  • ${l.name || l.phone} — ${l.predictive_score}/100 — ${l.insight}`
          ).join('\n');

          telegram.sendMessage(client.telegram_chat_id,
            `🎯 <b>Daily Lead Scoring Complete</b>\n\n` +
            `Scored: ${scores.length} leads\n` +
            `Hot leads (75+): ${hotLeads.length}\n\n` +
            `<b>Top priorities:</b>\n${topLeads}`
          ).catch(err => logger.warn('[scheduler] Lead scoring Telegram notify failed', err.message));
        }

        logger.info(`[Scheduler] Scored ${scores.length} leads for client ${client.id}, ${hotLeads.length} hot`);
      } catch (err) {
        logger.error(`[Scheduler] Lead scoring failed for client ${client.id}:`, err.message);
      }
    }
  } catch (err) {
    logger.error('[Scheduler] dailyLeadScoring error:', err);
  }
}

module.exports = { dailyLeadScoring };
