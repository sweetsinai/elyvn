/**
 * Lead Scoring — Analytics & Batch Operations
 *
 * Conversion analytics, batch scoring, and detailed report generation.
 * Core single-lead scoring lives in ./model.js.
 */

const { logger } = require('../logger');
const { predictLeadScore } = require('./model');

/**
 * Get conversion analytics for a client
 * @param {object} db
 * @param {string} clientId
 * @returns {{ conversion_rate: number, avg_touches_to_convert: number, best_contact_times: array, top_sources: array }}
 */
async function getConversionAnalytics(db, clientId) {
  if (!clientId) {
    return {
      conversion_rate: 0,
      avg_touches_to_convert: 0,
      best_contact_times: [],
      top_sources: [],
    };
  }

  try {
    const allLeads = await db.query('SELECT id, phone, stage, source, calcom_booking_id FROM leads WHERE client_id = ?', [clientId]);

    if (allLeads.length === 0) {
      return {
        conversion_rate: 0,
        avg_touches_to_convert: 0,
        best_contact_times: [],
        top_sources: [],
      };
    }

    const convertedLeads = allLeads.filter(l => l.stage === 'booked' || l.calcom_booking_id).length;
    const conversionRate = convertedLeads > 0 ? (convertedLeads / allLeads.length) * 100 : 0;

    const phones = allLeads.filter(l => l.stage === 'booked' || l.calcom_booking_id).map(l => l.phone).filter(Boolean);

    let avgTouchesToConvert = 0;
    const bestTimes = {};

    if (phones.length > 0) {
      const ph = phones.map(() => '?').join(',');
      const [callCountRows, msgCountRows, inboundMsgRows] = await Promise.all([
        db.query(`SELECT caller_phone, COUNT(*) as c FROM calls WHERE client_id=? AND caller_phone IN (${ph}) GROUP BY caller_phone`, [clientId, ...phones], 'all'),
        db.query(`SELECT phone, COUNT(*) as c FROM messages WHERE client_id=? AND phone IN (${ph}) GROUP BY phone`, [clientId, ...phones], 'all'),
        db.query(`SELECT phone, created_at FROM messages WHERE client_id=? AND phone IN (${ph}) AND direction='inbound' ORDER BY created_at ASC`, [clientId, ...phones], 'all'),
      ]);
      const callCountMap = Object.fromEntries(callCountRows.map(r => [r.caller_phone, r.c]));
      const msgCountMap = Object.fromEntries(msgCountRows.map(r => [r.phone, r.c]));
      const inboundByPhone = {};
      for (const m of inboundMsgRows) {
        if (!inboundByPhone[m.phone]) inboundByPhone[m.phone] = [];
        inboundByPhone[m.phone].push(m);
      }

      let totalTouches = 0;
      const leadsTouched = [];
      for (const phone of phones) {
        const touches = (callCountMap[phone] || 0) + (msgCountMap[phone] || 0);
        if (touches > 0) {
          totalTouches += touches;
          leadsTouched.push(touches);
        }
      }
      avgTouchesToConvert = leadsTouched.length > 0 ? totalTouches / leadsTouched.length : 0;

      for (const phone of phones) {
        for (const msg of (inboundByPhone[phone] || [])) {
          const hour = new Date(msg.created_at).getHours();
          bestTimes[hour] = (bestTimes[hour] || 0) + 1;
        }
      }
    }
    const bestContactTimes = Object.entries(bestTimes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([hour, count]) => ({ hour: parseInt(hour), frequency: count }));

    const sourceCounts = {};
    for (const lead of allLeads.filter(l => l.stage === 'booked' || l.calcom_booking_id)) {
      const source = lead.source || 'unknown';
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
    const topSources = Object.entries(sourceCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count }));

    return {
      conversion_rate: Math.round(conversionRate * 100) / 100,
      avg_touches_to_convert: Math.round(avgTouchesToConvert * 10) / 10,
      best_contact_times: bestContactTimes,
      top_sources: topSources,
    };
  } catch (error) {
    logger.error(`[Scoring] Error getting conversion analytics for ${clientId}:`, error.message);
    return {
      conversion_rate: 0,
      avg_touches_to_convert: 0,
      best_contact_times: [],
      top_sources: [],
    };
  }
}

/**
 * Batch score all active leads for a client
 * @param {object} db
 * @param {string} clientId
 * @returns {Array<{leadId, phone, name, predictive_score, insight, recommended_action}>}
 */
async function batchScoreLeads(db, clientId) {
  if (!clientId) {
    return [];
  }

  try {
    const activeLeads = await db.query(
      `SELECT id, phone, name FROM leads
       WHERE client_id = ? AND stage != 'lost' AND (stage != 'booked' OR calcom_booking_id IS NULL)
       ORDER BY updated_at DESC`,
      [clientId]
    );

    const scoredLeads = await Promise.all(
      activeLeads.map(async (lead) => {
        const scoreData = await predictLeadScore(db, lead.id, clientId);
        return {
          leadId: lead.id,
          phone: lead.phone,
          name: lead.name || 'Unknown',
          predictive_score: scoreData.score,
          insight: scoreData.insight,
          recommended_action: scoreData.recommended_action,
        };
      })
    );

    return scoredLeads.sort((a, b) => b.predictive_score - a.predictive_score);
  } catch (error) {
    logger.error(`[Scoring] Error batch scoring leads for ${clientId}:`, error.message);
    return [];
  }
}

/**
 * Get a detailed scoring report for a lead
 * @param {object} db
 * @param {string} leadId
 * @param {string} clientId
 * @returns {object}
 */
async function getLeadScoringReport(db, leadId, clientId) {
  if (!leadId || !clientId) return null;

  const lead = await db.query('SELECT id, phone, name, stage, source, created_at, updated_at FROM leads WHERE id = ? AND client_id = ?', [leadId, clientId], 'get');
  if (!lead) return null;

  const scoreData = await predictLeadScore(db, leadId, clientId);
  const analytics = await getConversionAnalytics(db, clientId);

  return {
    lead: {
      id: lead.id,
      phone: lead.phone,
      name: lead.name,
      stage: lead.stage,
      source: lead.source,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
    },
    score: scoreData.score,
    factors: scoreData.factors,
    factorExplanation: {
      responsiveness: 'How fast they responded to first outreach (25% weight)',
      engagement: 'Number of interactions: calls + messages (25% weight)',
      intent: 'Source quality, sentiment trend, call outcomes (20% weight)',
      recency: 'How recently they engaged (15% weight)',
      channelDiversity: 'Multi-channel engagement (15% weight)',
    },
    insight: scoreData.insight,
    recommended_action: scoreData.recommended_action,
    details: scoreData.details,
    benchmarks: {
      clientConversionRate: `${analytics.conversion_rate}%`,
      clientAvgTouches: analytics.avg_touches_to_convert,
      bestContactHours: analytics.best_contact_times.map(t => `${t.hour}:00`).join(', '),
      topSources: analytics.top_sources.map(s => `${s.source} (${s.count})`).join(', '),
    },
  };
}

module.exports = {
  getConversionAnalytics,
  batchScoreLeads,
  getLeadScoringReport,
};
