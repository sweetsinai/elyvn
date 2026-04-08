/**
 * Conversation Intelligence — Statistics & Analysis
 *
 * Call stats, message stats, response time analysis, sentiment distribution.
 */

const { AppError } = require('../AppError');

/**
 * Get full conversation intelligence report for a client
 * @param {object} db
 * @param {string} clientId
 * @param {number} [days=30] - Lookback period
 * @returns {{ summary, peak_hours, sentiment_trend, avg_call_duration, booking_rate, response_time_analysis, coaching_tips }}
 */
async function getConversationIntelligence(db, clientId, days = 30) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // === Call Statistics ===
  const callStats = await db.query(`
    SELECT
      COUNT(*) as total_calls,
      SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked_calls,
      SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed_calls,
      SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive_sentiment,
      SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral_sentiment,
      SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative_sentiment,
      AVG(duration) as avg_duration,
      MIN(duration) as min_duration,
      MAX(duration) as max_duration
    FROM calls
    WHERE client_id = ? AND created_at >= ?
  `, [clientId, since], 'get');

  // === Message Statistics ===
  const messageStats = await db.query(`
    SELECT
      COUNT(*) as total_messages,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound_messages,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound_messages
    FROM messages
    WHERE client_id = ? AND created_at >= ?
  `, [clientId, since], 'get');

  // === Response Time Analysis ===
  const responseTimeStats = await db.query(`
    WITH ranked_responses AS (
      SELECT
        m1.id as msg_id,
        CAST((julianday(m2.created_at) - julianday(m1.created_at)) * 24 * 60 AS INTEGER) as response_minutes,
        ROW_NUMBER() OVER (PARTITION BY m1.id ORDER BY m2.created_at ASC) as rn
      FROM messages m1
      LEFT JOIN messages m2 ON m1.phone = m2.phone
        AND m2.direction = 'inbound'
        AND m2.created_at > m1.created_at
        AND m2.created_at <= datetime(m1.created_at, '+2 hours')
      WHERE m1.client_id = ?
        AND m1.direction = 'outbound'
        AND m1.created_at >= ?
    ),
    first_responses AS (
      SELECT response_minutes
      FROM ranked_responses
      WHERE rn = 1 AND response_minutes IS NOT NULL
    )
    SELECT
      COUNT(*) as count,
      CAST(AVG(response_minutes) AS INTEGER) as avg_response_minutes
    FROM first_responses
  `, [clientId, since], 'get');

  const avgResponseMinutes = responseTimeStats.count > 0 ? responseTimeStats.avg_response_minutes : null;

  // === Sentiment Distribution ===
  const totalSentiment = (callStats.positive_sentiment || 0) +
                         (callStats.neutral_sentiment || 0) +
                         (callStats.negative_sentiment || 0);

  const sentimentDist = totalSentiment > 0 ? {
    positive: Math.round((callStats.positive_sentiment || 0) / totalSentiment * 100),
    neutral: Math.round((callStats.neutral_sentiment || 0) / totalSentiment * 100),
    negative: Math.round((callStats.negative_sentiment || 0) / totalSentiment * 100),
  } : { positive: 0, neutral: 0, negative: 0 };

  // === Booking Rate ===
  const bookingRate = callStats.total_calls > 0
    ? Math.round((callStats.booked_calls || 0) / callStats.total_calls * 100)
    : 0;

  // === Peak Hours ===
  const { getPeakHours } = require('./peakHours');
  const peakHours = await getPeakHours(db, clientId);

  // === Call Duration Trend ===
  const { getCallDurationTrend } = require('./trends');
  const durationTrend = await getCallDurationTrend(db, clientId, days);

  // === Common Questions/Topics (from transcripts) ===
  const { extractCommonTopics } = require('./topics');
  const commonTopics = await extractCommonTopics(db, clientId, since);

  // === Coaching Tips ===
  const { generateCoachingTips } = require('./coaching');
  const coachingTips = await generateCoachingTips(
    db,
    clientId,
    callStats,
    bookingRate,
    avgResponseMinutes,
    durationTrend
  );

  return {
    summary: {
      period_days: days,
      total_calls: callStats.total_calls || 0,
      total_messages: messageStats.total_messages || 0,
      booking_rate: `${bookingRate}%`,
      avg_call_duration_seconds: Math.round(callStats.avg_duration || 0),
      avg_response_time_minutes: avgResponseMinutes,
    },
    sentiment_distribution: sentimentDist,
    call_duration_stats: {
      average: Math.round(callStats.avg_duration || 0),
      minimum: callStats.min_duration || 0,
      maximum: callStats.max_duration || 0,
    },
    peak_hours: peakHours,
    call_duration_trend: durationTrend,
    common_topics: commonTopics,
    response_time_analysis: {
      avg_response_minutes: avgResponseMinutes,
      messages_with_reply: responseTimeStats.count || 0,
      total_outbound_messages: messageStats.outbound_messages || 0,
    },
    coaching_tips: coachingTips,
  };
}

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
      WHERE m1.client_id = ?
        AND m1.direction = 'outbound'
    ),
    first_responses_per_lead AS (
      SELECT response_minutes, converted, lead_id
      FROM ranked_responses
      WHERE rn = 1 AND response_minutes IS NOT NULL AND lead_id IS NOT NULL
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN response_minutes < 1 THEN '0-1 min'
          WHEN response_minutes < 5 THEN '1-5 min'
          WHEN response_minutes < 15 THEN '5-15 min'
          WHEN response_minutes < 60 THEN '15-60 min'
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
        WHEN range = '0-1 min' THEN 1
        WHEN range = '1-5 min' THEN 2
        WHEN range = '5-15 min' THEN 3
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
    ? validBuckets.reduce((best, current) =>
        parseInt(current.conversion_rate) > parseInt(best.conversion_rate) ? current : best
      )
    : null;

  const totalResponses = analysis.reduce((sum, b) => sum + b.count, 0);

  return {
    buckets: analysis,
    optimal_window: optimalBucket ? optimalBucket.range : 'Insufficient data',
    total_responses_analyzed: totalResponses,
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

  const thisWeekCalls = await db.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
      AVG(duration) as avg_duration
    FROM calls
    WHERE client_id = ? AND created_at >= ? AND created_at < ?
  `, [clientId, thisWeekStart.toISOString(), thisWeekEnd.toISOString()], 'get');

  const lastWeekCalls = await db.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
      AVG(duration) as avg_duration
    FROM calls
    WHERE client_id = ? AND created_at >= ? AND created_at < ?
  `, [clientId, lastWeekStart.toISOString(), lastWeekEnd.toISOString()], 'get');

  const thisWeekRate = thisWeekCalls.total > 0
    ? Math.round((thisWeekCalls.booked || 0) / thisWeekCalls.total * 100)
    : 0;

  const lastWeekRate = lastWeekCalls.total > 0
    ? Math.round((lastWeekCalls.booked || 0) / lastWeekCalls.total * 100)
    : 0;

  const callDifference = (thisWeekCalls.total || 0) - (lastWeekCalls.total || 0);
  const rateDifference = thisWeekRate - lastWeekRate;

  return {
    this_week: {
      total_calls: thisWeekCalls.total || 0,
      booking_rate: `${thisWeekRate}%`,
      avg_duration: Math.round(thisWeekCalls.avg_duration || 0),
    },
    last_week: {
      total_calls: lastWeekCalls.total || 0,
      booking_rate: `${lastWeekRate}%`,
      avg_duration: Math.round(lastWeekCalls.avg_duration || 0),
    },
    change: {
      calls_difference: callDifference,
      rate_difference: `${rateDifference > 0 ? '+' : ''}${rateDifference}%`,
      trend: callDifference > 0 ? 'increasing' : callDifference < 0 ? 'decreasing' : 'stable',
    },
  };
}

module.exports = {
  getConversationIntelligence,
  analyzeResponseTimeImpact,
  getWeekOverWeekComparison,
};
