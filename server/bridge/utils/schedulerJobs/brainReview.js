const { BRAIN_FOLLOWUP_THROTTLE_MS } = require('../../config/timing');
const { logger } = require('../logger');

async function dailyLeadReview(db) {
  const startTime = Date.now();
  let processed = 0;
  let errors = 0;

  try {
    const stale = await db.query(`
      SELECT l.*, c.id as cid
      FROM leads l
      JOIN clients c ON l.client_id = c.id
      WHERE c.is_active = 1
      AND l.stage NOT IN ('booked', 'lost')
      AND l.updated_at < datetime('now', '-2 days')
      AND l.score >= 5
      ORDER BY l.score DESC
      LIMIT 10
    `);

    if (stale.length === 0) {
      logger.info('[brainReview] START — no stale leads to process');
      logger.info('[brainReview] DONE — processed 0, errors 0, duration 0ms');
      return;
    }

    logger.info(`[brainReview] START — processing ${stale.length} stale leads`);

    const { getLeadMemory } = require('../leadMemory');
    const { think } = require('../brain');
    const { executeActions } = require('../actionExecutor');

    for (const lead of stale) {
      try {
        const memory = await getLeadMemory(db, lead.phone, lead.client_id);
        if (!memory) continue;

        const decision = await think('daily_review', {
          review_reason: 'Lead inactive 2+ days, not booked',
          lead_score: lead.score,
          lead_stage: lead.stage,
        }, memory, db);

        await executeActions(db, decision.actions, memory);
        processed++;
        await new Promise(r => setTimeout(r, BRAIN_FOLLOWUP_THROTTLE_MS));
      } catch (err) {
        logger.error(`[brainReview] Failed for ${lead.phone}:`, err.message);
        errors++;
      }
    }
  } catch (err) {
    logger.error('[brainReview] dailyLeadReview error:', err);
    errors++;
  }

  logger.info(`[brainReview] DONE — processed ${processed}, errors ${errors}, duration ${Date.now() - startTime}ms`);
}

module.exports = { dailyLeadReview };
