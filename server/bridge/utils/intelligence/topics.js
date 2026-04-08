/**
 * Conversation Intelligence — Common Topics Extraction
 */

const { AppError } = require('../AppError');

/**
 * Extract common topics/questions from transcripts
 * @param {object} db
 * @param {string} clientId
 * @param {string} since
 * @returns {Array<{topic: string, frequency: number}>}
 */
async function extractCommonTopics(db, clientId, since) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const topicFrequencies = await db.query(`
    SELECT
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%pricing%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%cost%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%price%' THEN 1 ELSE 0 END) as pricing_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%appointment%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%booking%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%schedule%' THEN 1 ELSE 0 END) as booking_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%available%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%availability%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%time%' THEN 1 ELSE 0 END) as availability_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%location%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%address%' THEN 1 ELSE 0 END) as location_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%service%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%features%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%benefits%' THEN 1 ELSE 0 END) as service_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%insurance%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%coverage%' THEN 1 ELSE 0 END) as insurance_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%question%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%help%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%support%' THEN 1 ELSE 0 END) as help_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%issue%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%problem%' OR LOWER(COALESCE(transcript, '') || COALESCE(summary, '')) LIKE '%complaint%' THEN 1 ELSE 0 END) as issue_freq
    FROM calls
    WHERE client_id = ? AND created_at >= ? AND (transcript IS NOT NULL OR summary IS NOT NULL)
  `, [clientId, since], 'get');

  const topics = [
    { topic: 'Pricing', frequency: topicFrequencies.pricing_freq || 0 },
    { topic: 'Booking', frequency: topicFrequencies.booking_freq || 0 },
    { topic: 'Availability', frequency: topicFrequencies.availability_freq || 0 },
    { topic: 'Location', frequency: topicFrequencies.location_freq || 0 },
    { topic: 'Service', frequency: topicFrequencies.service_freq || 0 },
    { topic: 'Insurance', frequency: topicFrequencies.insurance_freq || 0 },
    { topic: 'Help', frequency: topicFrequencies.help_freq || 0 },
    { topic: 'Issue', frequency: topicFrequencies.issue_freq || 0 },
  ];

  return topics
    .filter(t => t.frequency > 0)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 8);
}

module.exports = { extractCommonTopics };
