const { classifyReply } = require('./replyClassifier');

/**
 * Automatically classify unclassified replies using AI
 * @param {Database} db - SQLite database instance
 * @returns {Promise<Object>} - { classified: number, results: Array, message: string }
 */
async function autoClassifyReplies(db) {
  try {
    // Fetch all unclassified replies
    const unclassified = db.prepare(`
      SELECT id, reply_text, subject
      FROM emails_sent
      WHERE reply_text IS NOT NULL AND reply_classification IS NULL
      ORDER BY reply_at DESC
      LIMIT 100
    `).all();

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
        const classification = await classifyReply(email.reply_text, email.subject);

        // Update the database with the classification
        db.prepare(`
          UPDATE emails_sent
          SET reply_classification = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(classification.classification, email.id);

        results.push({
          id: email.id,
          classification: classification.classification,
          summary: classification.summary
        });

        successCount++;
      } catch (err) {
        console.error(`[autoClassify] Error classifying email ${email.id}:`, err.message);
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
    console.error('[autoClassify] Fatal error:', err.message);
    throw err;
  }
}

module.exports = { autoClassifyReplies };
