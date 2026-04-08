/**
 * Conversation Intelligence — Per-Call Analysis
 *
 * Assembles the full conversation intelligence report for a client,
 * aggregating call stats, message stats, sentiment, response times,
 * peak hours, and common topic extraction.
 */

const { AppError } = require('../AppError');

/**
 * Get peak activity hours for a client
 * @param {object} db
 * @param {string} clientId
 * @returns {Array<{hour: number, day: string, calls: number, messages: number, bookings: number}>}
 */
async function getPeakHours(db, clientId) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const hourStats = await db.query(`
    SELECT
      CAST(strftime('%H', calls.created_at) AS INTEGER) as hour,
      strftime('%w', calls.created_at) as dow_num,
      COUNT(*) as call_count,
      SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booking_count
    FROM calls
    WHERE client_id = ?
    GROUP BY hour, dow_num
    ORDER BY call_count DESC
    LIMIT 24
  `, [clientId]);

  const messageStats = await db.query(`
    SELECT
      CAST(strftime('%H', created_at) AS INTEGER) as hour,
      strftime('%w', created_at) as dow_num,
      COUNT(*) as msg_count
    FROM messages
    WHERE client_id = ?
    GROUP BY hour, dow_num
    LIMIT 24
  `, [clientId]);

  const msgMap = new Map();
  for (const stat of messageStats) {
    msgMap.set(`${stat.hour}:${stat.dow_num}`, stat.msg_count);
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return hourStats.map(stat => ({
    hour: stat.hour,
    day: dayNames[parseInt(stat.dow_num)],
    calls: stat.call_count || 0,
    messages: msgMap.get(`${stat.hour}:${stat.dow_num}`) || 0,
    bookings: stat.booking_count || 0,
  })).slice(0, 14);
}

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

  const f = await db.query(`
    SELECT
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%pricing%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%cost%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%price%' THEN 1 ELSE 0 END) as pricing_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%appointment%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%booking%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%schedule%' THEN 1 ELSE 0 END) as booking_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%available%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%availability%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%time%' THEN 1 ELSE 0 END) as availability_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%location%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%address%' THEN 1 ELSE 0 END) as location_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%service%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%features%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%benefits%' THEN 1 ELSE 0 END) as service_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%insurance%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%coverage%' THEN 1 ELSE 0 END) as insurance_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%question%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%help%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%support%' THEN 1 ELSE 0 END) as help_freq,
      SUM(CASE WHEN LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%issue%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%problem%' OR LOWER(COALESCE(transcript,'') || COALESCE(summary,'')) LIKE '%complaint%' THEN 1 ELSE 0 END) as issue_freq
    FROM calls
    WHERE client_id = ? AND created_at >= ? AND (transcript IS NOT NULL OR summary IS NOT NULL)
  `, [clientId, since], 'get');

  return [
    { topic: 'Pricing',      frequency: f.pricing_freq || 0 },
    { topic: 'Booking',      frequency: f.booking_freq || 0 },
    { topic: 'Availability', frequency: f.availability_freq || 0 },
    { topic: 'Location',     frequency: f.location_freq || 0 },
    { topic: 'Service',      frequency: f.service_freq || 0 },
    { topic: 'Insurance',    frequency: f.insurance_freq || 0 },
    { topic: 'Help',         frequency: f.help_freq || 0 },
    { topic: 'Issue',        frequency: f.issue_freq || 0 },
  ]
    .filter(t => t.frequency > 0)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 8);
}

/**
 * Get full conversation intelligence report for a client
 * @param {object} db
 * @param {string} clientId
 * @param {number} [days=30] - Lookback period
 * @returns {{ summary, sentiment_distribution, call_duration_stats, peak_hours, call_duration_trend, common_topics, response_time_analysis, coaching_tips }}
 */
async function getConversationIntelligence(db, clientId, days = 30) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

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

  const messageStats = await db.query(`
    SELECT
      COUNT(*) as total_messages,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound_messages,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound_messages
    FROM messages
    WHERE client_id = ? AND created_at >= ?
  `, [clientId, since], 'get');

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
      WHERE m1.client_id = ? AND m1.direction = 'outbound' AND m1.created_at >= ?
    ),
    first_responses AS (
      SELECT response_minutes FROM ranked_responses WHERE rn = 1 AND response_minutes IS NOT NULL
    )
    SELECT COUNT(*) as count, CAST(AVG(response_minutes) AS INTEGER) as avg_response_minutes
    FROM first_responses
  `, [clientId, since], 'get');

  const avgResponseMinutes = responseTimeStats.count > 0 ? responseTimeStats.avg_response_minutes : null;

  const totalSentiment = (callStats.positive_sentiment || 0) +
                         (callStats.neutral_sentiment || 0) +
                         (callStats.negative_sentiment || 0);

  const sentimentDist = totalSentiment > 0 ? {
    positive: Math.round((callStats.positive_sentiment || 0) / totalSentiment * 100),
    neutral:  Math.round((callStats.neutral_sentiment  || 0) / totalSentiment * 100),
    negative: Math.round((callStats.negative_sentiment || 0) / totalSentiment * 100),
  } : { positive: 0, neutral: 0, negative: 0 };

  const bookingRate = callStats.total_calls > 0
    ? Math.round((callStats.booked_calls || 0) / callStats.total_calls * 100)
    : 0;

  const { getCallDurationTrend } = require('./sentimentTrend');
  const { generateCoachingTips } = require('./coachingTips');

  const peakHours    = await getPeakHours(db, clientId);
  const durationTrend = await getCallDurationTrend(db, clientId, days);
  const commonTopics  = await extractCommonTopics(db, clientId, since);
  const coachingTips  = await generateCoachingTips(db, clientId, callStats, bookingRate, avgResponseMinutes, durationTrend);

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

module.exports = { getConversationIntelligence, getPeakHours, extractCommonTopics };
