/**
 * Conversation Intelligence Module
 *
 * Analyzes patterns across all calls and messages to identify coaching opportunities
 * and track performance over time with intelligent insights.
 */

/**
 * Get full conversation intelligence report for a client
 * @param {object} db
 * @param {string} clientId
 * @param {number} [days=30] - Lookback period
 * @returns {{ summary, peak_hours, sentiment_trend, avg_call_duration, booking_rate, response_time_analysis, coaching_tips }}
 */
function getConversationIntelligence(db, clientId, days = 30) {
  if (!db || !clientId) {
    throw new Error('db and clientId are required');
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // === Call Statistics ===
  const callStats = db.prepare(`
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
  `).get(clientId, since);

  // === Message Statistics ===
  const messageStats = db.prepare(`
    SELECT
      COUNT(*) as total_messages,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound_messages,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound_messages
    FROM messages
    WHERE client_id = ? AND created_at >= ?
  `).get(clientId, since);

  // === Response Time Analysis ===
  // Calculate average response time using SQL aggregation
  // Uses ROW_NUMBER to get first response per outbound message, then AVG
  const responseTimeStats = db.prepare(`
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
  `).get(clientId, since);

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
  const peakHours = getPeakHours(db, clientId);

  // === Call Duration Trend ===
  const durationTrend = getCallDurationTrend(db, clientId, days);

  // === Common Questions/Topics (from transcripts) ===
  const commonTopics = extractCommonTopics(db, clientId, since);

  // === Coaching Tips ===
  const coachingTips = generateCoachingTips(
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
function analyzeResponseTimeImpact(db, clientId) {
  if (!db || !clientId) {
    throw new Error('db and clientId are required');
  }

  // Get response time buckets with conversion stats using SQL aggregation
  const bucketStats = db.prepare(`
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
  `).all(clientId, clientId);

  // Define bucket order for consistent output
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

  // Ensure all buckets are present in output
  const analysis = bucketOrder.map(name =>
    bucketMap.get(name) || { range: name, count: 0, conversions: 0, conversion_rate: '0%' }
  );

  // Find optimal window (highest conversion rate with minimum count of 2)
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
 * Get peak activity hours for a client
 * @param {object} db
 * @param {string} clientId
 * @returns {Array<{hour: number, day: string, calls: number, messages: number, bookings: number}>}
 */
function getPeakHours(db, clientId) {
  if (!db || !clientId) {
    throw new Error('db and clientId are required');
  }

  // Extract hour and day of week from timestamps
  const hourStats = db.prepare(`
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
  `).all(clientId);

  const messageStats = db.prepare(`
    SELECT
      CAST(strftime('%H', created_at) AS INTEGER) as hour,
      strftime('%w', created_at) as dow_num,
      COUNT(*) as msg_count
    FROM messages
    WHERE client_id = ?
    GROUP BY hour, dow_num
    LIMIT 24
  `).all(clientId);

  // Create a map of message stats by hour and dow
  const msgMap = new Map();
  for (const stat of messageStats) {
    msgMap.set(`${stat.hour}:${stat.dow_num}`, stat.msg_count);
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Combine call and message data
  const combined = hourStats.map(stat => ({
    hour: stat.hour,
    day: dayNames[parseInt(stat.dow_num)],
    calls: stat.call_count || 0,
    messages: msgMap.get(`${stat.hour}:${stat.dow_num}`) || 0,
    bookings: stat.booking_count || 0,
  }));

  return combined.slice(0, 14); // Top 14 hours
}

/**
 * Get call duration trend over time
 * @param {object} db
 * @param {string} clientId
 * @param {number} days
 * @returns {Array<{week: string, avg_duration: number, call_count: number}>}
 */
function getCallDurationTrend(db, clientId, days) {
  if (!db || !clientId) {
    throw new Error('db and clientId are required');
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const weeklyTrend = db.prepare(`
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
  `).all(clientId, since);

  return weeklyTrend.map(w => ({
    week: w.week,
    avg_duration: Math.round(w.avg_duration || 0),
    call_count: w.call_count || 0,
    min_duration: w.min_duration || 0,
    max_duration: w.max_duration || 0,
  }));
}

/**
 * Extract common topics/questions from transcripts
 * @param {object} db
 * @param {string} clientId
 * @param {string} since
 * @returns {Array<{topic: string, frequency: number}>}
 */
function extractCommonTopics(db, clientId, since) {
  if (!db || !clientId) {
    throw new Error('db and clientId are required');
  }

  // Use SQL to count keyword occurrences across all transcripts and summaries
  // Avoids fetching all transcript text and processing in JavaScript
  const topicFrequencies = db.prepare(`
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
  `).get(clientId, since);

  // Convert frequency counts to topic array and sort
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

  // Return top topics sorted by frequency
  return topics
    .filter(t => t.frequency > 0)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 8);
}

/**
 * Generate actionable coaching tips based on analysis
 * @param {object} db
 * @param {string} clientId
 * @param {object} callStats
 * @param {number} bookingRate
 * @param {number|null} avgResponseMinutes
 * @param {Array} durationTrend
 * @returns {Array<string>}
 */
function generateCoachingTips(db, clientId, callStats, bookingRate, avgResponseMinutes, durationTrend) {
  const tips = [];

  // Tip 1: Call duration impact
  if (callStats.avg_duration !== null) {
    const avgDuration = callStats.avg_duration;

    // Analyze booking rate by call duration buckets - combined query
    const durationStats = db.prepare(`
      SELECT
        CASE WHEN duration > 120 THEN 'long' ELSE 'short' END as duration_type,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
      FROM calls
      WHERE client_id = ? AND duration > 0
      GROUP BY duration_type
    `).all(clientId);

    const statsMap = new Map();
    for (const stat of durationStats) {
      statsMap.set(stat.duration_type, stat);
    }

    const shortCalls = statsMap.get('short') || { total: 0, booked: 0 };
    const longCalls = statsMap.get('long') || { total: 0, booked: 0 };

    if (shortCalls.total > 5 && longCalls.total > 5) {
      const shortRate = Math.round((shortCalls.booked || 0) / shortCalls.total * 100);
      const longRate = Math.round((longCalls.booked || 0) / longCalls.total * 100);

      if (longRate > shortRate * 2) {
        tips.push(`Calls over 2 minutes have ${longRate}% booking rate vs ${shortRate}% for shorter calls. Aim for deeper conversations.`);
      }
    }

    if (avgDuration < 60) {
      tips.push(`Average call duration is ${Math.round(avgDuration)} seconds. Longer calls typically convert better—aim for 2+ minutes.`);
    }
  }

  // Tip 2: Response time impact
  if (avgResponseMinutes !== null && avgResponseMinutes > 0) {
    if (avgResponseMinutes < 5) {
      tips.push(`Lightning-fast responses (${avgResponseMinutes} min avg). Maintain this speed—quick replies boost conversions 3x.`);
    } else if (avgResponseMinutes < 60) {
      tips.push(`Response time is ${avgResponseMinutes} minutes. Aim for under 5 minutes to maximize conversion probability.`);
    } else {
      tips.push(`Slow response time (${Math.round(avgResponseMinutes / 60)} hours avg). Respond within 1 minute for best conversion rates.`);
    }
  }

  // Tip 3: Booking rate assessment
  if (bookingRate < 10) {
    tips.push(`Booking rate is only ${bookingRate}%. Review call quality and follow-up strategy—industry average is 15-30%.`);
  } else if (bookingRate > 35) {
    tips.push(`Excellent booking rate of ${bookingRate}%! Continue current approach and document your winning tactics.`);
  }

  // Tip 4: Sentiment analysis
  const totalSentiment = (callStats.positive_sentiment || 0) +
                         (callStats.neutral_sentiment || 0) +
                         (callStats.negative_sentiment || 0);
  if (totalSentiment > 10) {
    const negativeRate = Math.round((callStats.negative_sentiment || 0) / totalSentiment * 100);
    if (negativeRate > 20) {
      tips.push(`${negativeRate}% of calls have negative sentiment. Address customer pain points and improve solution positioning.`);
    }
  }

  // Tip 5: Trend analysis
  if (durationTrend.length >= 2) {
    const recent = durationTrend[durationTrend.length - 1];
    const previous = durationTrend[durationTrend.length - 2];

    if (recent.avg_duration > previous.avg_duration) {
      const increase = Math.round(((recent.avg_duration - previous.avg_duration) / previous.avg_duration) * 100);
      tips.push(`Week-over-week: call duration up ${increase}%. This positive trend suggests better engagement.`);
    }
  }

  // Tip 6: Peak hours optimization
  const peakData = getPeakHours(db, clientId);
  if (peakData.length > 0) {
    const best = peakData.reduce((a, b) =>
      ((a.bookings || 0) / Math.max(a.calls, 1)) > ((b.bookings || 0) / Math.max(b.calls, 1)) ? a : b
    );

    if (best && best.bookings > 2) {
      tips.push(`Peak conversion window: ${best.day} ${best.hour}:00-${best.hour + 1}:00. Schedule key staff during this time.`);
    }
  }

  return tips.slice(0, 5); // Return top 5 tips
}

/**
 * Get week-over-week comparison metrics
 * @param {object} db
 * @param {string} clientId
 * @returns {{ this_week: object, last_week: object, change: object }}
 */
function getWeekOverWeekComparison(db, clientId) {
  if (!db || !clientId) {
    throw new Error('db and clientId are required');
  }

  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - now.getDay()); // Start of this week

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(thisWeekStart.getDate() - 7); // Start of last week

  const thisWeekEnd = new Date(thisWeekStart);
  thisWeekEnd.setDate(thisWeekStart.getDate() + 7);

  const lastWeekEnd = new Date(thisWeekStart);

  // This week stats
  const thisWeekCalls = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
      AVG(duration) as avg_duration
    FROM calls
    WHERE client_id = ? AND created_at >= ? AND created_at < ?
  `).get(clientId, thisWeekStart.toISOString(), thisWeekEnd.toISOString());

  // Last week stats
  const lastWeekCalls = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
      AVG(duration) as avg_duration
    FROM calls
    WHERE client_id = ? AND created_at >= ? AND created_at < ?
  `).get(clientId, lastWeekStart.toISOString(), lastWeekEnd.toISOString());

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
  getPeakHours,
  getCallDurationTrend,
  extractCommonTopics,
  generateCoachingTips,
  getWeekOverWeekComparison,
};
