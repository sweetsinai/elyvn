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
  const responseTimeData = db.prepare(`
    SELECT
      m1.id as msg_id,
      m1.created_at as sent_at,
      m2.created_at as reply_at,
      CAST((julianday(m2.created_at) - julianday(m1.created_at)) * 24 * 60 AS INTEGER) as response_minutes,
      l.id as lead_id
    FROM messages m1
    LEFT JOIN messages m2 ON m1.phone = m2.phone
      AND m2.direction = 'inbound'
      AND m2.created_at > m1.created_at
      AND m2.created_at <= datetime(m1.created_at, '+2 hours')
    LEFT JOIN leads l ON l.phone = m1.phone AND l.client_id = ?
    WHERE m1.client_id = ?
      AND m1.direction = 'outbound'
      AND m1.created_at >= ?
    LIMIT 100
  `).all(clientId, clientId, since);

  // Filter to first response only per conversation
  const responseMap = new Map();
  const firstResponses = [];
  for (const r of responseTimeData) {
    if (r.reply_at && !responseMap.has(r.msg_id)) {
      firstResponses.push(r);
      responseMap.set(r.msg_id, true);
    }
  }

  const avgResponseMinutes = firstResponses.length > 0
    ? Math.round(firstResponses.reduce((sum, r) => sum + (r.response_minutes || 0), 0) / firstResponses.length)
    : null;

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
      messages_with_reply: firstResponses.length,
      total_outbound_messages: callStats.total_calls > 0 ? callStats.total_calls : 0,
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

  // Get messages with response data
  const responseData = db.prepare(`
    SELECT
      m1.id as msg_id,
      m1.created_at as sent_at,
      m2.created_at as reply_at,
      CAST((julianday(m2.created_at) - julianday(m1.created_at)) * 24 * 60 AS INTEGER) as response_minutes,
      l.id as lead_id,
      CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END as converted
    FROM messages m1
    LEFT JOIN messages m2 ON m1.phone = m2.phone
      AND m2.direction = 'inbound'
      AND m2.created_at > m1.created_at
      AND m2.created_at <= datetime(m1.created_at, '+24 hours')
    LEFT JOIN leads l ON l.phone = m1.phone AND l.client_id = ?
    LEFT JOIN appointments a ON a.lead_id = l.id
    WHERE m1.client_id = ?
      AND m1.direction = 'outbound'
    ORDER BY m1.created_at DESC
    LIMIT 200
  `).all(clientId, clientId);

  // Filter to first response per lead
  const leadResponseMap = new Map();
  const uniqueResponses = [];
  for (const r of responseData) {
    if (r.lead_id && !leadResponseMap.has(r.lead_id)) {
      uniqueResponses.push(r);
      leadResponseMap.set(r.lead_id, true);
    }
  }

  // Group into buckets
  const buckets = [
    { name: '0-1 min', min: 0, max: 1 },
    { name: '1-5 min', min: 1, max: 5 },
    { name: '5-15 min', min: 5, max: 15 },
    { name: '15-60 min', min: 15, max: 60 },
    { name: '1-4 hours', min: 60, max: 240 },
    { name: '4+ hours', min: 240, max: Infinity },
  ];

  const analysis = buckets.map(bucket => {
    const matching = uniqueResponses.filter(r =>
      r.response_minutes !== null &&
      r.response_minutes >= bucket.min &&
      r.response_minutes < bucket.max
    );

    const conversions = matching.filter(r => r.converted).length;
    const conversionRate = matching.length > 0
      ? Math.round(conversions / matching.length * 100)
      : 0;

    return {
      range: bucket.name,
      count: matching.length,
      conversions: conversions,
      conversion_rate: `${conversionRate}%`,
    };
  });

  // Find optimal window (highest conversion rate with minimum count)
  const validBuckets = analysis.filter(b => b.count >= 2);
  const optimalBucket = validBuckets.length > 0
    ? validBuckets.reduce((best, current) =>
        parseInt(current.conversion_rate) > parseInt(best.conversion_rate) ? current : best
      )
    : null;

  return {
    buckets: analysis,
    optimal_window: optimalBucket ? optimalBucket.range : 'Insufficient data',
    total_responses_analyzed: uniqueResponses.length,
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

  // Get all transcripts
  const transcripts = db.prepare(`
    SELECT transcript, summary
    FROM calls
    WHERE client_id = ? AND created_at >= ? AND (transcript IS NOT NULL OR summary IS NOT NULL)
  `).all(clientId, since);

  const topicFreq = new Map();

  // Simple keyword extraction from summaries
  const keywords = [
    'pricing', 'cost', 'price', 'appointment', 'booking', 'schedule',
    'available', 'availability', 'time', 'date', 'location', 'address',
    'service', 'services', 'features', 'benefits', 'insurance', 'coverage',
    'question', 'help', 'support', 'issue', 'problem', 'complaint'
  ];

  for (const call of transcripts) {
    const text = ((call.summary || '') + ' ' + (call.transcript || '')).toLowerCase();
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        topicFreq.set(keyword, (topicFreq.get(keyword) || 0) + 1);
      }
    }
  }

  // Return top topics
  return Array.from(topicFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([topic, freq]) => ({
      topic: topic.charAt(0).toUpperCase() + topic.slice(1),
      frequency: freq,
    }));
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

    // Analyze booking rate by call duration buckets
    const shortCalls = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
      FROM calls
      WHERE client_id = ? AND duration > 0 AND duration <= 120
    `).get(clientId);

    const longCalls = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
      FROM calls
      WHERE client_id = ? AND duration > 120
    `).get(clientId);

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
