/**
 * Lead Scoring — Predictive Model & Analytics
 *
 * Main scoring entry point. Orchestrates factor calculations (./factors.js)
 * using weights from ./weights.js.
 */

const { logger } = require('../logger');
const { calcResponsiveness, calcEngagement, calcIntent, calcRecency, calcChannelDiversity, calcAiScore } = require('./factors');
const {
  WEIGHTS,
  SCORE_BANDS,
  ACTION_THRESHOLDS,
  ACTION_FALLBACK_STALE,
  ACTION_FALLBACK_DEFAULT,
  STALE_HOURS,
} = require('./weights');

const MODEL_VERSION = 'v1.0';

/**
 * Calculate predictive lead score using historical patterns
 * @param {object} db - better-sqlite3 instance
 * @param {string} leadId
 * @param {string} clientId
 * @returns {{ score: number, factors: object, insight: string, recommended_action: string }}
 */
async function predictLeadScore(db, leadId, clientId) {
  if (!leadId || !clientId) {
    return {
      score: 0,
      model_version: MODEL_VERSION,
      factors: {},
      insight: 'Insufficient data',
      recommended_action: 'none',
    };
  }

  try {
    const lead = await db.query('SELECT * FROM leads WHERE id = ? AND client_id = ?', [leadId, clientId], 'get');
    if (!lead) {
      return {
        score: 0,
        model_version: MODEL_VERSION,
        factors: {},
        insight: 'Lead not found',
        recommended_action: 'none',
      };
    }

    const calls = await db.query(
      `SELECT id, duration, outcome, score, sentiment, created_at FROM calls
       WHERE caller_phone = ? AND client_id = ? ORDER BY created_at ASC`,
      [lead.phone, clientId]
    );

    const messages = await db.query(
      `SELECT id, direction, body, status, created_at FROM messages
       WHERE phone = ? AND client_id = ? ORDER BY created_at ASC`,
      [lead.phone, clientId]
    );

    // Find first outbound message/call
    let firstOutreach = null;
    for (const msg of messages) {
      if (msg.direction === 'outbound') {
        firstOutreach = new Date(msg.created_at);
        break;
      }
    }
    if (!firstOutreach && calls.length > 0) {
      firstOutreach = new Date(calls[0].created_at);
    }

    // Calculate all factors
    const { responsiveFactor, firstResponse } = calcResponsiveness(messages, calls, firstOutreach);
    const { engagementFactor, totalInteractions, inboundMessages } = calcEngagement(calls, messages);
    const { intentFactor, qualifiedCalls } = calcIntent(lead, calls, messages);
    const { recencyFactor, lastInteractionTime } = calcRecency(messages, calls);
    const { channelFactor } = calcChannelDiversity(calls, messages);
    const { aiFactor } = calcAiScore(lead, calls);

    // FINAL SCORE CALCULATION
    const finalScore = Math.max(0, Math.min(100, Math.round(
      (responsiveFactor  * WEIGHTS.responsiveness) +
      (engagementFactor  * WEIGHTS.engagement) +
      (intentFactor      * WEIGHTS.intent) +
      (recencyFactor     * WEIGHTS.recency) +
      (channelFactor     * WEIGHTS.channelDiversity) +
      (aiFactor          * WEIGHTS.aiScore)
    )));

    // GENERATE INSIGHT
    let insight = '';
    if (finalScore >= SCORE_BANDS.HOT) {
      insight = `High urgency — responded in ${firstResponse && firstOutreach ? Math.round((firstResponse - firstOutreach) / 60000) : '?'} min, multi-channel`;
    } else if (finalScore >= SCORE_BANDS.WARM) {
      if (inboundMessages > 0) {
        insight = 'Warm lead — actively engaging, multiple touches';
      } else if (qualifiedCalls > 0) {
        insight = 'Hot lead — booked appointment after 3 touches';
      } else {
        insight = 'Warm lead — responsive but needs nurturing';
      }
    } else if (finalScore >= SCORE_BANDS.MODERATE) {
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
    const actionEntry = ACTION_THRESHOLDS.find(t => finalScore >= t.min);
    let recommendedAction;
    if (actionEntry) {
      recommendedAction = actionEntry.action;
    } else if (lastInteractionTime && (Date.now() - lastInteractionTime) / 3600000 > STALE_HOURS) {
      recommendedAction = ACTION_FALLBACK_STALE;
    } else {
      recommendedAction = ACTION_FALLBACK_DEFAULT;
    }

    // Persist ML features alongside scoring
    try {
      const { extractFeatures, persistFeatures } = require('../featureStore');
      const { recordMetric } = require('../metrics');
      const featureResult = await extractFeatures(db, leadId);
      if (featureResult && Object.keys(featureResult.features).length > 0) {
        try {
          await persistFeatures(db, leadId, featureResult.features);
        } catch (err1) {
          logger.warn('[Scoring] Feature persist failed, retrying...', err1.message);
          try {
            await persistFeatures(db, leadId, featureResult.features);
          } catch (err2) {
            logger.error('[Scoring] Feature persist failed after retry:', err2.message);
            recordMetric('feature_persist_failures', 1, 'counter');
          }
        }
      }
    } catch (featureErr) {
      logger.warn(`[Scoring] Feature extraction failed for ${leadId}: ${featureErr.message}`);
      try {
        const { recordMetric } = require('../metrics');
        recordMetric('feature_persist_failures', 1, 'counter');
      } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
    }

    return {
      score: finalScore,
      model_version: MODEL_VERSION,
      factors: {
        responsiveness: Math.round(responsiveFactor),
        engagement: Math.round(engagementFactor),
        intent: Math.round(intentFactor),
        recency: Math.round(recencyFactor),
        channelDiversity: Math.round(channelFactor),
        aiScore: Math.round(aiFactor),
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
      model_version: MODEL_VERSION,
      factors: {},
      insight: `Error: ${error.message}`,
      recommended_action: 'none',
    };
  }
}

module.exports = { predictLeadScore };
