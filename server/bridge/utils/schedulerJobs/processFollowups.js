const { BRAIN_FOLLOWUP_THROTTLE_MS } = require('../../config/timing');
const { logger } = require('../logger');

async function processFollowups(db) {
  try {
    const due = db.prepare(
      `SELECT f.*, l.phone, l.client_id as lead_client_id
       FROM followups f
       JOIN leads l ON f.lead_id = l.id
       WHERE f.status = 'scheduled' AND f.scheduled_at <= datetime('now')
       LIMIT 10`
    ).all();

    if (due.length === 0) return;
    logger.info(`[Scheduler] Processing ${due.length} due follow-ups`);

    const { getLeadMemory } = require('../leadMemory');
    const { think } = require('../brain');
    const { executeActions } = require('../actionExecutor');

    for (const followup of due) {
      try {
        const memory = getLeadMemory(db, followup.phone, followup.lead_client_id || followup.client_id);
        if (!memory) {
          db.prepare("UPDATE followups SET status = 'failed' WHERE id = ?").run(followup.id);
          continue;
        }

        const decision = await think('followup_due', {
          followup_id: followup.id,
          touch_number: followup.touch_number,
          original_message: followup.content,
          scheduled_at: followup.scheduled_at,
        }, memory, db);

        await executeActions(db, decision.actions, memory);
        db.prepare("UPDATE followups SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(followup.id);
      } catch (err) {
        logger.error(`[Scheduler] Follow-up ${followup.id} failed:`, err.message);
        db.prepare("UPDATE followups SET status = 'failed' WHERE id = ?").run(followup.id);
      }

      // Rate limit between brain calls
      await new Promise(r => setTimeout(r, BRAIN_FOLLOWUP_THROTTLE_MS));
    }
  } catch (err) {
    logger.error('[Scheduler] processFollowups error:', err);
  }
}

module.exports = { processFollowups };
