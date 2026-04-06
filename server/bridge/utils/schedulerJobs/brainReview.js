const { BRAIN_FOLLOWUP_THROTTLE_MS } = require('../../config/timing');
const { logger } = require('../logger');

async function dailyLeadReview(db) {
  try {
    const stale = db.prepare(`
      SELECT l.*, c.id as cid
      FROM leads l
      JOIN clients c ON l.client_id = c.id
      WHERE c.is_active = 1
      AND l.stage NOT IN ('booked', 'lost')
      AND l.updated_at < datetime('now', '-2 days')
      AND l.score >= 5
      ORDER BY l.score DESC
      LIMIT 10
    `).all();

    if (stale.length === 0) {
      logger.info('[Brain] Daily review: no stale leads');
      return;
    }

    logger.info(`[Brain] Daily review: ${stale.length} stale leads`);

    const { getLeadMemory } = require('../leadMemory');
    const { think } = require('../brain');
    const { executeActions } = require('../actionExecutor');

    for (const lead of stale) {
      try {
        const memory = getLeadMemory(db, lead.phone, lead.client_id);
        if (!memory) continue;

        const decision = await think('daily_review', {
          review_reason: 'Lead inactive 2+ days, not booked',
          lead_score: lead.score,
          lead_stage: lead.stage,
        }, memory, db);

        await executeActions(db, decision.actions, memory);
        await new Promise(r => setTimeout(r, BRAIN_FOLLOWUP_THROTTLE_MS));
      } catch (err) {
        logger.error(`[Brain] Daily review failed for ${lead.phone}:`, err.message);
      }
    }
  } catch (err) {
    logger.error('[Brain] dailyLeadReview error:', err);
  }
}

module.exports = { dailyLeadReview };
