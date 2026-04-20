const telegram = require('../telegram');
const { logger } = require('../logger');
const { appendEvent, Events } = require('../eventStore');
const { checkFeatureStaleness, batchExtractFeatures, persistFeatures } = require('../featureStore');
const { recordMetric } = require('../metrics');

async function dailyLeadScoring(db) {
  const startTime = Date.now();
  let totalScored = 0;
  let errors = 0;

  try {
    const { batchScoreLeads } = require('../leadScoring');
    const clients = await db.query('SELECT id, telegram_chat_id FROM clients WHERE is_active = 1');

    logger.info(`[leadScoring] START — processing ${clients.length} clients`);

    for (const client of clients) {
      try {
        const scores = await batchScoreLeads(db, client.id);
        const hotLeads = scores.filter(s => s.predictive_score >= 75);

        // Update lead scores in the DB based on predictive model
        for (const s of scores) {
          // Keep 0-100 predictive score as the lead score
          const newScore = Math.round(s.predictive_score);
          await db.query('UPDATE leads SET score = ?, updated_at = datetime(\'now\') WHERE id = ?',
            [newScore, s.leadId], 'run');

          // Fire-and-forget: emit LeadScored event per lead
          try {
            await appendEvent(db, s.leadId, 'lead', Events.LeadScored, {
              score: newScore,
              factors: { predictive_score: s.predictive_score },
              model_version: 'v1.0',
            }, client.id);
          } catch (_) {}
        }

        totalScored += scores.length;

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
          ).catch(err => logger.warn('[leadScoring] Telegram notify failed', err.message));
        }

        // Emit summary event per client
        const clientDuration = Date.now() - startTime;
        try {
          await appendEvent(db, client.id, 'client', Events.BatchScoringCompleted, {
            leadsScored: scores.length,
            duration: clientDuration,
          }, client.id);
        } catch (evtErr) {
          logger.warn(`[leadScoring] Failed to emit BatchScoringCompleted for ${client.id}:`, evtErr.message);
        }

        logger.info(`[leadScoring] Client ${client.id}: scored ${scores.length} leads, ${hotLeads.length} hot`);
      } catch (err) {
        logger.error(`[leadScoring] Failed for client ${client.id}:`, err.message);
        errors++;
      }
    }
  } catch (err) {
    logger.error('[leadScoring] dailyLeadScoring error:', err);
    errors++;
  }

  // Check feature staleness across all active clients and auto-refresh stale features
  try {
    const allClients = await db.query('SELECT id FROM clients WHERE is_active = 1');
    let totalStale = 0;
    let totalRefreshed = 0;
    for (const c of allClients) {
      const staleLeads = await checkFeatureStaleness(db, c.id, 7);
      totalStale += staleLeads.length;

      if (staleLeads.length > 0) {
        try {
          const refreshed = await batchExtractFeatures(db, c.id);
          for (const entry of refreshed) {
            if (entry.features && Object.keys(entry.features).length > 0) {
              await persistFeatures(db, entry.leadId, entry.features);
              totalRefreshed++;
            }
          }
          logger.info(`[leadScoring] Refreshed features for ${refreshed.length} leads in client ${c.id}`);
        } catch (refreshErr) {
          logger.error(`[leadScoring] Feature refresh failed for client ${c.id}:`, refreshErr.message);
        }
      }
    }
    recordMetric('features_stale_count', totalStale, 'gauge');
    recordMetric('features_refreshed_count', totalRefreshed, 'gauge');
    if (totalStale > 0) {
      logger.warn(`[leadScoring] ${totalStale} leads had stale features (>7 days old), refreshed ${totalRefreshed}`);
    }
  } catch (err) {
    logger.error('[leadScoring] Feature staleness check failed:', err.message);
  }

  logger.info(`[leadScoring] DONE — processed ${totalScored} leads, errors ${errors}, duration ${Date.now() - startTime}ms`);
}

module.exports = { dailyLeadScoring };
