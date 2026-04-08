/**
 * Conversation Intelligence — Sentiment Tracking & Trend Analysis
 *
 * Response time impact on conversions, week-over-week comparison,
 * and call duration trend over time.
 */

const { AppError } = require('../AppError');

/**
 * Analyze response time impact on conversions
 * @param {object} db
 * @param {string} clientId
 * @returns {{ buckets: Array<{range, count, conversion_rate}>, optimal_window: string }}
 */
async function analyzeResponseTimeImpact(db, clientId) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const bucketStats = await db.query(`
    WITH ranked_responses AS (
      SELECT
        m1.id as msg_id,
        l.id as lead_id,
        CAST((julianday(m2.created_at) - julianday(m1.created_at)) * 24 * 60 AS INTEGER) as response_minutes,
        CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END as converted,
        ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY m1.created_at ASC) as rn
      FROM messages m1
      LEFT JOIN messages m2 ON m1.phone = m2.phone
        AND m2.direction = 'inbound'
        AND m2.created_at > m1.created_at
        AND m2.created_at <= datetime(m1.created_at, '+24 hours')
      LEFT JOIN leads l ON l.phone = m1.phone AND l.client_id = ?
      LEFT JOIN appointments a ON a.lead_id = l.id
      WHERE m1.client_id = ? AND m1.direction = 'outbound'
    ),
    first_responses_per_lead AS (
      SELECT response_minutes, converted, lead_id
      FROM ranked_responses
      WHERE rn = 1 AND response_minutes IS NOT NULL AND lead_id IS NOT NULL
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN response_minutes < 1   THEN '0-1 min'
          WHEN response_minutes < 5   THEN '1-5 min'
          WHEN response_minutes < 15  THEN '5-15 min'
          WHEN response_minutes < 60  THEN '15-60 min'
          WHEN response_minutes < 240 THEN '1-4 hours'
          ELSE '4+ hours'
        END as range,
        response_minutes,
        converted
      FROM first_responses_per_lead
    )
    SELECT
      range,
      COUNT(*) as count,
      SUM(converted) as conversions,
      CAST(ROUND(SUM(converted) * 100.0 / COUNT(*)) AS INTEGER) as conversion_rate
    FROM bucketed
    GROUP BY range
    ORDER BY
      CASE
        WHEN range = '0-1 min'   THEN 1
        WHEN range = '1-5 min'   THEN 2
        WHEN range = '5-15 min'  THEN 3
        WHEN range = '15-60 min' THEN 4
        WHEN range = '1-4 hours' THEN 5
        ELSE 6
      END
  `, [clientId, clientId]);

  const bucketOrder = ['0-1 min', '1-5 min', '5-15 min', '15-60 min', '1-4 hours', '4+ hours'];
  const bucketMap = new Map();
  for (const bucket of bucketStats) {
    bucketMap.set(bucket.range, {
      range: bucket.range,
      count: bucket.count || 0,
      conversions: bucket.conversions || 0,
      conversion_rate: `${bucket.conversion_rate || 0}%`,
    });
  }

  const analysis = bucketOrder.map(name =>
    bucketMap.get(name) || { range: name, count: 0, conversions: 0, conversion_rate: '0%' }
  );

  const validBuckets = analysis.filter(b => b.count >= 2);
  const optimalBucket = validBuckets.length > 0
    ? validBuckets.reduce((best, cur) =>
        parseInt(cur.conversion_rate) > parseInt(best.conversion_rate) ? cur : best
      )
    : null;

  return {
    buckets: analysis,
    optimal_window: optimalBucket ? optimalBucket.range : 'Insufficient data',
    total_responses_analyzed: analysis.reduce((sum, b) => sum + b.count, 0),
  };
}

/**
 * Get week-over-week comparison metrics
 * @param {object} db
 * @param {string} clientId
 * @returns {{ this_week: object, last_week: object, change: object }}
 */
async function getWeekOverWeekComparison(db, clientId) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - now.getDay());

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(thisWeekStart.getDate() - 7);

  const thisWeekEnd = new Date(thisWeekStart);
  thisWeekEnd.setDate(thisWeekStart.getDate() + 7);

  const lastWeekEnd = new Date(thisWeekStart);

  const [thisWeekCalls, lastWeekCalls] = await Promise.all([
    db.query(`
      SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked, AVG(duration) as avg_duration
      FROM calls WHERE client_id = ? AND created_at >= ? AND created_at < ?
    `, [clientId, thisWeekStart.toISOString(), thisWeekEnd.toISOString()], 'get'),
    db.query(`
      SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked, AVG(duration) as avg_duration
      FROM calls WHERE client_id = ? AND created_at >= ? AND created_at < ?
    `, [clientId, lastWeekStart.toISOString(), lastWeekEnd.toISOString()], 'get'),
  ]);

  const thisRate = thisWeekCalls.total > 0
    ? Math.round((thisWeekCalls.booked || 0) / thisWeekCalls.total * 100) : 0;
  const lastRate = lastWeekCalls.total > 0
    ? Math.round((lastWeekCalls.booked || 0) / lastWeekCalls.total * 100) : 0;

  const callDiff = (thisWeekCalls.total || 0) - (lastWeekCalls.total || 0);
  const rateDiff = thisRate - lastRate;

  return {
    this_week: {
      total_calls: thisWeekCalls.total || 0,
      booking_rate: `${thisRate}%`,
      avg_duration: Math.round(thisWeekCalls.avg_duration || 0),
    },
    last_week: {
      total_calls: lastWeekCalls.total || 0,
      booking_rate: `${lastRate}%`,
      avg_duration: Math.round(lastWeekCalls.avg_duration || 0),
    },
    change: {
      calls_difference: callDiff,
      rate_difference: `${rateDiff > 0 ? '+' : ''}${rateDiff}%`,
      trend: callDiff > 0 ? 'increasing' : callDiff < 0 ? 'decreasing' : 'stable',
    },
  };
}

/**
 * Get call duration trend over time
 * @param {object} db
 * @param {string} clientId
 * @param {number} days
 * @returns {Array<{week: string, avg_duration: number, call_count: number, min_duration: number, max_duration: number}>}
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

module.exports = {
  analyzeResponseTimeImpact,
  getWeekOverWeekComparison,
  getCallDurationTrend,
};
