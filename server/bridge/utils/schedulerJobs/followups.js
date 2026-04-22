'use strict';

const { logger } = require('../logger');
const { BRAIN_FOLLOWUP_THROTTLE_MS } = require('../../config/timing');

/**
 * Process scheduled follow-ups.
 * Handles 'brain' type follow-ups by invoking the AI decision engine.
 */
async function processFollowups(db) {
  const now = new Date().toISOString();
  try {
    const due = await db.query(`
      SELECT * FROM followups
      WHERE status = 'scheduled'
      AND scheduled_at <= ?
      AND type = 'brain'
      LIMIT 10
    `, [now]);

    if (due.length === 0) return;

    logger.info(`[Scheduler] Processing ${due.length} due follow-ups`);

    const { getLeadMemory } = require('../leadMemory');
    const { think } = require('../brain');
    const { executeActions } = require('../actionExecutor');

    for (const followup of due) {
      try {
        const memory = await getLeadMemory(db, null, followup.client_id, followup.lead_id);
        if (!memory) {
          logger.warn(`[Scheduler] No memory found for followup ${followup.id}, lead ${followup.lead_id}`);
          await db.query("UPDATE followups SET status = 'failed', updated_at = ? WHERE id = ?", [now, followup.id], 'run');
          continue;
        }

        const decision = await think('followup', {
          followup_content: followup.content,
          touch_number: followup.touch_number
        }, memory, db);

        if (decision && decision.actions) {
          await executeActions(db, decision.actions, memory);
        }

        await db.query("UPDATE followups SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?", [now, now, followup.id], 'run');
        
        // Throttling to avoid hitting AI rate limits
        await new Promise(r => setTimeout(r, BRAIN_FOLLOWUP_THROTTLE_MS));
      } catch (err) {
        logger.error(`[Scheduler] Followup ${followup.id} failed:`, err.message);
        const attempts = (followup.attempts || 0) + 1;
        if (attempts >= 3) {
          await db.query("UPDATE followups SET status = 'failed', updated_at = ? WHERE id = ?", [now, followup.id], 'run');
        } else {
          await db.query("UPDATE followups SET attempts = ?, updated_at = ? WHERE id = ?", [attempts, now, followup.id], 'run');
        }
      }
    }
  } catch (err) {
    logger.error('[Scheduler] processFollowups error:', err.message);
  }
}

module.exports = { processFollowups };
