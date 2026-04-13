const { BRAIN_FOLLOWUP_THROTTLE_MS } = require('../../config/timing');
const { logger } = require('../logger');

async function processFollowups(db) {
  const startTime = Date.now();
  let processed = 0;
  let errors = 0;

  try {
    const due = await db.query(
      `SELECT f.*, l.phone, l.client_id as lead_client_id
       FROM followups f
       JOIN leads l ON f.lead_id = l.id
       WHERE f.status = 'scheduled' AND f.scheduled_at <= ?
       LIMIT 10`,
      [new Date().toISOString()]
    );

    if (due.length === 0) return;
    logger.info(`[processFollowups] START — processing ${due.length} due follow-ups`);

    const { getLeadMemory } = require('../leadMemory');
    const { think } = require('../brain');
    const { executeActions } = require('../actionExecutor');

    for (const followup of due) {
      try {
        const memory = await getLeadMemory(db, followup.phone, followup.lead_client_id || followup.client_id);
        if (!memory) {
          await db.query("UPDATE followups SET status = 'failed' WHERE id = ?", [followup.id], 'run');
          errors++;
          continue;
        }

        const decision = await think('followup_due', {
          followup_id: followup.id,
          touch_number: followup.touch_number,
          original_message: followup.content,
          scheduled_at: followup.scheduled_at,
        }, memory, db);

        await executeActions(db, decision.actions, memory);
        await db.query("UPDATE followups SET status = 'sent', sent_at = ? WHERE id = ?", [new Date().toISOString(), followup.id], 'run');
        processed++;
      } catch (err) {
        logger.error(`[processFollowups] Follow-up ${followup.id} failed:`, err.message);
        await db.query("UPDATE followups SET status = 'failed' WHERE id = ?", [followup.id], 'run');
        errors++;
      }

      // Rate limit between brain calls
      await new Promise(r => setTimeout(r, BRAIN_FOLLOWUP_THROTTLE_MS));
    }
  } catch (err) {
    logger.error('[processFollowups] error:', err);
    errors++;
  }

  logger.info(`[processFollowups] DONE — processed ${processed}, errors ${errors}, duration ${Date.now() - startTime}ms`);
}

module.exports = { processFollowups };
