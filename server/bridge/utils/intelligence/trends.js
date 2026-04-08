/**
 * Conversation Intelligence — Duration Trends
 */

const { AppError } = require('../AppError');

/**
 * Get call duration trend over time
 * @param {object} db
 * @param {string} clientId
 * @param {number} days
 * @returns {Array<{week: string, avg_duration: number, call_count: number}>}
 */
async function getCallDurationTrend(db, clientId, days) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const weeklyTrend = await db.query(`
    SELECT
      strftime('%Y-W%W', created_at) as week,
      COUNT(*) as call_count,
      AVG(duration) as avg_duration,
      MIN(duration) as min_duration,
      MAX(duration) as max_duration
    FROM calls
    WHERE client_id = ? AND created_at >= ?
    GROUP BY week
    ORDER BY week ASC
  `, [clientId, since]);

  return weeklyTrend.map(w => ({
    week: w.week,
    avg_duration: Math.round(w.avg_duration || 0),
    call_count: w.call_count || 0,
    min_duration: w.min_duration || 0,
    max_duration: w.max_duration || 0,
  }));
}

module.exports = { getCallDurationTrend };
