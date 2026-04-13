const { classifyReply } = require('./replyClassifier');
const { logger } = require('./logger');

const CONFIDENCE_THRESHOLD = parseFloat(process.env.REPLY_CONFIDENCE_THRESHOLD || '0.7');

// Classification → leads.stage mapping
const CLASSIFICATION_STAGE_MAP = {
  INTERESTED: 'interested',
  NOT_INTERESTED: 'not_interested',
  UNSUBSCRIBE: 'unsubscribed',
  QUESTION: 'engaged',
};

/**
 * Automatically classify unclassified replies using AI.
 * Also updates leads.stage and records opt-outs for UNSUBSCRIBE classifications.
 * @param {Database} db - SQLite database instance
 * @returns {Promise<Object>} - { classified: number, results: Array, message: string }
 */
async function autoClassifyReplies(db) {
  try {
    // Fetch all unclassified replies, joining prospect data for lead stage updates
    const unclassified = await db.query(`
      SELECT es.id, es.reply_text, es.subject, es.prospect_id, es.to_email,
             p.phone as prospect_phone
      FROM emails_sent es
      LEFT JOIN prospects p ON p.id = es.prospect_id
      WHERE es.reply_text IS NOT NULL AND es.reply_classification IS NULL
      ORDER BY es.reply_at DESC
      LIMIT 100
    `);

    if (unclassified.length === 0) {
      return {
        classified: 0,
        results: [],
        message: 'No unclassified replies found'
      };
    }

    const results = [];
    let successCount = 0;

    // Process each unclassified reply
    for (const email of unclassified) {
      try {
        // Idempotency check: skip if already classified (race condition guard)
        const current = await db.query(
          'SELECT reply_classification FROM emails_sent WHERE id = ?',
          [email.id], 'get'
        );
        if (current && current.reply_classification) {
          logger.info(`[autoClassify] Skipping email ${email.id} — already classified as ${current.reply_classification}`);
          continue;
        }

        const classification = await classifyReply(email.reply_text, email.subject);
        const cls = classification.classification;
        const confidence = classification.confidence ?? 0;

        // Confidence gate: determine final classification before writing (single write, no race)
        const autoUpdateStage = confidence >= CONFIDENCE_THRESHOLD;
        const finalClassification = autoUpdateStage ? cls : 'needs_review';
        if (!autoUpdateStage) {
          logger.warn(`[autoClassify] Low confidence (${confidence.toFixed(2)}) for email ${email.id} classified as ${cls} — marking needs_review, skipping stage update`);
        }

        // Single write with the final classification
        await db.query(`
          UPDATE emails_sent
          SET reply_classification = ?, updated_at = ?
          WHERE id = ?
        `, [finalClassification, new Date().toISOString(), email.id], 'run');

        // Update lead stage based on classification (only if confident)
        const newStage = CLASSIFICATION_STAGE_MAP[cls];
        if (autoUpdateStage && newStage && email.prospect_id) {
          try {
            // Find the lead record linked to this prospect (by prospect_id or email)
            const lead = await db.query(
              'SELECT id FROM leads WHERE prospect_id = ? LIMIT 1',
              [email.prospect_id], 'get'
            ) || await db.query(
                'SELECT id FROM leads WHERE email = ? LIMIT 1',
                [email.to_email], 'get'
              );

            if (lead) {
              await db.query(
                "UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?",
                [newStage, new Date().toISOString(), lead.id], 'run'
              );
              logger.info(`[autoClassify] Lead ${lead.id} stage → ${newStage} (${cls}, confidence=${confidence.toFixed(2)})`);
            }
          } catch (stageErr) {
            logger.error(`[autoClassify] Failed to update lead stage for email ${email.id}:`, stageErr.message);
          }
        }

        // Record opt-out for UNSUBSCRIBE
        if (cls === 'UNSUBSCRIBE' && email.prospect_phone) {
          try {
            const { recordOptOut } = require('./optOut');
            // Find the client_id from any lead linked to this prospect
            const leadRow = await db.query(
              'SELECT client_id FROM leads WHERE prospect_id = ? LIMIT 1',
              [email.prospect_id], 'get'
            );
            if (leadRow) {
              recordOptOut(db, email.prospect_phone, leadRow.client_id, 'email_unsubscribe');
              logger.info(`[autoClassify] Opt-out recorded for ${email.prospect_phone}`);
            }
          } catch (optErr) {
            logger.error(`[autoClassify] Failed to record opt-out for email ${email.id}:`, optErr.message);
          }
        }

        results.push({
          id: email.id,
          classification: cls,
          summary: classification.summary
        });

        successCount++;
      } catch (err) {
        logger.error(`[autoClassify] Error classifying email ${email.id}:`, err.message);
        results.push({
          id: email.id,
          error: err.message
        });
      }
    }

    return {
      classified: successCount,
      results,
      message: `Classified ${successCount}/${unclassified.length} replies`
    };
  } catch (err) {
    logger.error('[autoClassify] Fatal error:', err.message);
    throw err;
  }
}

module.exports = { autoClassifyReplies };
