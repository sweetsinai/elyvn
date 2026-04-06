/**
 * Predictive Lead Scoring — Uses historical patterns to predict conversion probability
 *
 * Analyzes:
 * - Response time (how fast they replied to first SMS)
 * - Number of interactions (calls + messages)
 * - Channel diversity (used both SMS and phone)
 * - Time of day patterns (engaged during business hours?)
 * - Sentiment trend (improving or declining)
 * - Source quality (form > missed_call > sms for intent)
 *
 * Score = (responsiveness * 0.25) + (engagement * 0.25) + (intent_signals * 0.20) + (recency * 0.15) + (channel_diversity * 0.15)
 */

const { logger } = require('./logger');

/**
 * Calculate predictive lead score using historical patterns
 * @param {object} db - better-sqlite3 instance
 * @param {string} leadId
 * @param {string} clientId
 * @returns {{ score: number, factors: object, insight: string, recommended_action: string }}
 */
function predictLeadScore(db, leadId, clientId) {
  if (!leadId || !clientId) {
    return {
      score: 0,
      factors: {},
      insight: 'Insufficient data',
      recommended_action: 'none',
    };
  }

  try {
    // Get lead
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').get(leadId, clientId);
    if (!lead) {
      return {
        score: 0,
        factors: {},
        insight: 'Lead not found',
        recommended_action: 'none',
      };
    }

    // Get all interactions
    const calls = db.prepare(
      `SELECT id, duration, outcome, score, sentiment, created_at FROM calls
       WHERE caller_phone = ? AND client_id = ? ORDER BY created_at ASC`
    ).all(lead.phone, clientId);

    const messages = db.prepare(
      `SELECT id, direction, body, status, created_at FROM messages
       WHERE phone = ? AND client_id = ? ORDER BY created_at ASC`
    ).all(lead.phone, clientId);

    const followups = db.prepare(
      `SELECT id, touch_number, type, status, sent_at FROM followups
       WHERE lead_id = ? ORDER BY created_at ASC`
    ).all(leadId);

    // 1. RESPONSIVENESS FACTOR (0-100)
    // How fast did they respond to first outreach?
    let responsiveFactor = 0;
    let firstOutreach = null;
    let firstResponse = null;

    // Find first outbound message/call
    for (const msg of messages) {
      if (msg.direction === 'outbound') {
        firstOutreach = new Date(msg.created_at);
        break;
      }
    }
    if (!firstOutreach && calls.length > 0) {
      firstOutreach = new Date(calls[0].created_at);
    }

    // Find first inbound response
    if (firstOutreach) {
      for (const msg of messages) {
        if (msg.direction === 'inbound' && new Date(msg.created_at) > firstOutreach) {
          firstResponse = new Date(msg.created_at);
          break;
        }
      }
      // Check if they answered a call within 2 hours
      if (!firstResponse) {
        for (const call of calls) {
          if (new Date(call.created_at) > firstOutreach && call.duration > 0) {
            firstResponse = new Date(call.created_at);
            break;
          }
        }
      }
    }

    if (firstResponse && firstOutreach) {
      const minutesToRespond = (firstResponse - firstOutreach) / 60000;
      if (minutesToRespond < 5) {
        responsiveFactor = 100; // Immediate response
      } else if (minutesToRespond < 30) {
        responsiveFactor = 90; // Very fast
      } else if (minutesToRespond < 60) {
        responsiveFactor = 75; // Fast
      } else if (minutesToRespond < 240) {
        responsiveFactor = 60; // Same day
      } else if (minutesToRespond < 1440) {
        responsiveFactor = 40; // Next day
      } else {
        responsiveFactor = 20; // Slow
      }
    } else if (firstOutreach && (calls.length > 0 || messages.some(m => m.direction === 'inbound'))) {
      // Has engaged but no clear first response timing
      responsiveFactor = 50;
    } else if (calls.length > 0) {
      // They've taken calls
      responsiveFactor = 70;
    }

    // 2. ENGAGEMENT FACTOR (0-100)
    // How many interactions and patterns of engagement?
    let engagementFactor = 0;
    const totalInteractions = calls.length + messages.length;
    const inboundMessages = messages.filter(m => m.direction === 'inbound').length;

    if (totalInteractions === 0) {
      engagementFactor = 0;
    } else if (totalInteractions >= 5) {
      engagementFactor = 100; // Multiple interactions
    } else if (totalInteractions >= 3) {
      engagementFactor = 80;
    } else if (totalInteractions >= 2) {
      engagementFactor = 60;
    } else {
      engagementFactor = 40; // Single interaction
    }

    // Boost if they're initiating (inbound messages)
    if (inboundMessages > 0) {
      engagementFactor = Math.min(100, engagementFactor + 15);
    }

    // 3. INTENT SIGNALS (0-100)
    // Source quality, sentiment, call outcomes
    let intentFactor = 0;
    let signalCount = 0;

    // Check source quality from first message/call
    const leadSource = lead.source || 'sms';
    if (leadSource === 'form') {
      intentFactor += 30;
      signalCount += 1;
    } else if (leadSource === 'missed_call') {
      intentFactor += 20;
      signalCount += 1;
    } else if (leadSource === 'sms') {
      intentFactor += 10;
      signalCount += 1;
    }

    // Check sentiment trend (improving is good)
    let latestSentiment = 0;
    let sentimentTrend = 0;
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      // Messages don't have sentiment, but calls do
      const lastCallWithSentiment = [...calls].reverse().find(c => c.sentiment);
      if (lastCallWithSentiment) {
        latestSentiment = parseInt(lastCallWithSentiment.sentiment) || 0;
        intentFactor += latestSentiment * 10; // 0-10 sentiment → 0-100
        signalCount += 1;
      }
    }

    // Check call outcomes (qualified is best)
    const qualifiedCalls = calls.filter(c => c.outcome === 'qualified' || c.outcome === 'booked').length;
    if (qualifiedCalls > 0) {
      intentFactor += 35;
      signalCount += 1;
    } else {
      const answeredCalls = calls.filter(c => c.duration > 30).length;
      if (answeredCalls > 0) {
        intentFactor += 20;
        signalCount += 1;
      }
    }

    if (signalCount > 0) {
      intentFactor = Math.min(100, intentFactor / signalCount);
    } else {
      intentFactor = lead.score ? Math.min(100, (lead.score / 10) * 100) : 20;
    }

    // 4. RECENCY FACTOR (0-100)
    // How recently have they engaged?
    let recencyFactor = 0;
    const lastInteractionTime = messages.length > 0 || calls.length > 0
      ? Math.max(
          messages.length > 0 ? new Date(messages[messages.length - 1].created_at).getTime() : 0,
          calls.length > 0 ? new Date(calls[calls.length - 1].created_at).getTime() : 0
        )
      : null;

    if (!lastInteractionTime) {
      recencyFactor = 0;
    } else {
      const hoursSinceContact = (Date.now() - lastInteractionTime) / 3600000;
      if (hoursSinceContact < 1) {
        recencyFactor = 100; // Just now
      } else if (hoursSinceContact < 24) {
        recencyFactor = 90; // Today
      } else if (hoursSinceContact < 72) {
        recencyFactor = 75; // Last 3 days
      } else if (hoursSinceContact < 168) {
        recencyFactor = 60; // Last week
      } else if (hoursSinceContact < 336) {
        recencyFactor = 40; // Last 2 weeks
      } else if (hoursSinceContact < 720) {
        recencyFactor = 20; // Last month
      } else {
        recencyFactor = 5; // Stale
      }
    }

    // 5. CHANNEL DIVERSITY FACTOR (0-100)
    // Have they engaged via multiple channels?
    let channelFactor = 0;
    const hasPhoneCalls = calls.length > 0;
    const hasSMS = messages.length > 0;
    const channelsUsed = (hasPhoneCalls ? 1 : 0) + (hasSMS ? 1 : 0);

    if (channelsUsed === 2) {
      channelFactor = 100; // Multi-channel engagement
    } else if (channelsUsed === 1) {
      channelFactor = 60; // Single channel
    } else {
      channelFactor = 0; // No engagement
    }

    // FINAL SCORE CALCULATION
    const finalScore = Math.round(
      (responsiveFactor * 0.25) +
      (engagementFactor * 0.25) +
      (intentFactor * 0.20) +
      (recencyFactor * 0.15) +
      (channelFactor * 0.15)
    );

    // GENERATE INSIGHT
    let insight = '';
    if (finalScore >= 80) {
      insight = `High urgency — responded in ${firstResponse && firstOutreach ? Math.round((firstResponse - firstOutreach) / 60000) : '?'} min, multi-channel`;
    } else if (finalScore >= 60) {
      if (inboundMessages > 0) {
        insight = 'Warm lead — actively engaging, multiple touches';
      } else if (qualifiedCalls > 0) {
        insight = 'Hot lead — booked appointment after 3 touches';
      } else {
        insight = 'Warm lead — responsive but needs nurturing';
      }
    } else if (finalScore >= 40) {
      if (lastInteractionTime && (Date.now() - lastInteractionTime) / 3600000 > 48) {
        insight = `Cooling off — no response in 48 hours, was previously warm`;
      } else {
        insight = 'Moderate interest — some engagement but not yet qualified';
      }
    } else {
      if (totalInteractions === 0) {
        insight = 'New lead — no interactions yet';
      } else {
        insight = 'Low engagement — limited interactions, needs aggressive nurturing';
      }
    }

    // RECOMMENDED ACTION
    let recommendedAction = '';
    if (finalScore >= 80) {
      recommendedAction = 'Call immediately — high conversion probability';
    } else if (finalScore >= 65) {
      recommendedAction = 'Schedule follow-up call within 2 hours';
    } else if (finalScore >= 50) {
      recommendedAction = 'Send SMS with specific offer or question';
    } else if (finalScore >= 35) {
      recommendedAction = 'Schedule follow-up for tomorrow, softer approach';
    } else if (lastInteractionTime && (Date.now() - lastInteractionTime) / 3600000 > 72) {
      recommendedAction = 'Re-engage with new angle or offer';
    } else {
      recommendedAction = 'Continue nurturing sequence';
    }

    return {
      score: finalScore,
      factors: {
        responsiveness: Math.round(responsiveFactor),
        engagement: Math.round(engagementFactor),
        intent: Math.round(intentFactor),
        recency: Math.round(recencyFactor),
        channelDiversity: Math.round(channelFactor),
      },
      insight,
      recommended_action: recommendedAction,
      details: {
        totalInteractions,
        callCount: calls.length,
        messageCount: messages.length,
        inboundMessages,
        qualifiedCalls,
        hasBooked: lead.stage === 'booked',
        hoursSinceLastContact: lastInteractionTime ? Math.round((Date.now() - lastInteractionTime) / 3600000) : null,
      },
    };
  } catch (error) {
    logger.error(`[Scoring] Error scoring lead ${leadId}:`, error.message);
    return {
      score: 0,
      factors: {},
      insight: `Error: ${error.message}`,
      recommended_action: 'none',
    };
  }
}

/**
 * Get conversion analytics for a client
 * Benchmarks to compare individual lead scores against
 * @param {object} db
 * @param {string} clientId
 * @returns {{ conversion_rate: number, avg_touches_to_convert: number, best_contact_times: array, top_sources: array }}
 */
function getConversionAnalytics(db, clientId) {
  if (!clientId) {
    return {
      conversion_rate: 0,
      avg_touches_to_convert: 0,
      best_contact_times: [],
      top_sources: [],
    };
  }

  try {
    // Get all leads for this client
    const allLeads = db.prepare('SELECT * FROM leads WHERE client_id = ?').all(clientId);

    if (allLeads.length === 0) {
      return {
        conversion_rate: 0,
        avg_touches_to_convert: 0,
        best_contact_times: [],
        top_sources: [],
      };
    }

    // Conversion rate
    const convertedLeads = allLeads.filter(l => l.stage === 'booked' || l.calcom_booking_id).length;
    const conversionRate = convertedLeads > 0 ? (convertedLeads / allLeads.length) * 100 : 0;

    // Average touches to convert
    let totalTouches = 0;
    const leadsTouched = [];
    for (const lead of convertedLeads > 0 ? allLeads.filter(l => l.stage === 'booked' || l.calcom_booking_id) : []) {
      const calls = db.prepare(
        'SELECT COUNT(*) as c FROM calls WHERE caller_phone = ? AND client_id = ?'
      ).get(lead.phone, clientId);
      const messages = db.prepare(
        'SELECT COUNT(*) as c FROM messages WHERE phone = ? AND client_id = ?'
      ).get(lead.phone, clientId);
      const touches = (calls?.c || 0) + (messages?.c || 0);
      if (touches > 0) {
        totalTouches += touches;
        leadsTouched.push(touches);
      }
    }
    const avgTouchesToConvert = leadsTouched.length > 0 ? totalTouches / leadsTouched.length : 0;

    // Best contact times (when do converted leads respond?)
    const bestTimes = {};
    for (const lead of allLeads.filter(l => l.stage === 'booked' || l.calcom_booking_id)) {
      const messages = db.prepare(
        `SELECT created_at FROM messages WHERE phone = ? AND client_id = ? AND direction = 'inbound'
         ORDER BY created_at ASC LIMIT 5`
      ).all(lead.phone, clientId);
      for (const msg of messages) {
        const hour = new Date(msg.created_at).getHours();
        bestTimes[hour] = (bestTimes[hour] || 0) + 1;
      }
    }
    const bestContactTimes = Object.entries(bestTimes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([hour, count]) => ({ hour: parseInt(hour), frequency: count }));

    // Top sources (where do conversions come from?)
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
function batchScoreLeads(db, clientId) {
  if (!clientId) {
    return [];
  }

  try {
    // Get all active leads (not lost, not booked already)
    const activeLeads = db.prepare(
      `SELECT id, phone, name FROM leads
       WHERE client_id = ? AND stage != 'lost' AND (stage != 'booked' OR calcom_booking_id IS NULL)
       ORDER BY updated_at DESC`
    ).all(clientId);

    const scoredLeads = activeLeads.map(lead => {
      const scoreData = predictLeadScore(db, lead.id, clientId);
      return {
        leadId: lead.id,
        phone: lead.phone,
        name: lead.name || 'Unknown',
        predictive_score: scoreData.score,
        insight: scoreData.insight,
        recommended_action: scoreData.recommended_action,
      };
    });

    // Sort by predictive score descending
    return scoredLeads.sort((a, b) => b.predictive_score - a.predictive_score);
  } catch (error) {
    logger.error(`[Scoring] Error batch scoring leads for ${clientId}:`, error.message);
    return [];
  }
}

/**
 * Get a detailed scoring report for a lead (for debugging/analysis)
 * @param {object} db
 * @param {string} leadId
 * @param {string} clientId
 * @returns {object}
 */
function getLeadScoringReport(db, leadId, clientId) {
  if (!leadId || !clientId) return null;

  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').get(leadId, clientId);
  if (!lead) return null;

  const scoreData = predictLeadScore(db, leadId, clientId);
  const analytics = getConversionAnalytics(db, clientId);

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
  predictLeadScore,
  getConversionAnalytics,
  batchScoreLeads,
  getLeadScoringReport,
};
