/**
 * Conversation Intelligence — Coaching Tips Generation
 */

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
async function generateCoachingTips(db, clientId, callStats, bookingRate, avgResponseMinutes, durationTrend) {
  const tips = [];

  // Tip 1: Call duration impact
  if (callStats.avg_duration !== null) {
    const avgDuration = callStats.avg_duration;

    const durationStats = await db.query(`
      SELECT
        CASE WHEN duration > 120 THEN 'long' ELSE 'short' END as duration_type,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked
      FROM calls
      WHERE client_id = ? AND duration > 0
      GROUP BY duration_type
    `, [clientId]);

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
  const { getPeakHours } = require('./peakHours');
  const peakData = await getPeakHours(db, clientId);
  if (peakData.length > 0) {
    const best = peakData.reduce((a, b) =>
      ((a.bookings || 0) / Math.max(a.calls, 1)) > ((b.bookings || 0) / Math.max(b.calls, 1)) ? a : b
    );

    if (best && best.bookings > 2) {
      tips.push(`Peak conversion window: ${best.day} ${best.hour}:00-${best.hour + 1}:00. Schedule key staff during this time.`);
    }
  }

  return tips.slice(0, 5);
}

module.exports = { generateCoachingTips };
