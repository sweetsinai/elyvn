/**
 * Lead Intelligence — uses feature store data to generate actionable insights
 *
 * Consumes persisted features (responseTime, channelDiversity, recency, etc.)
 * and produces human-readable recommendations per lead, plus client-wide
 * priority rankings.
 */

const { logger } = require('./logger');

const FEATURE_VERSION = 'v1';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Load all features for a single lead from the feature_store table.
 * @returns {object} key/value map of feature names to numeric values
 */
async function loadLeadFeatures(db, leadId) {
  const rows = await db.query(`
    SELECT feature_name, feature_value
    FROM feature_store
    WHERE lead_id = ? AND feature_version = ?
  `, [leadId, FEATURE_VERSION]);

  const features = {};
  for (const row of rows) {
    features[row.feature_name] = row.feature_value;
  }
  return features;
}

/**
 * Batch-load features for multiple leads in a single query.
 * @param {object} db - database instance
 * @param {string[]} leadIds - array of lead IDs
 * @returns {Map<string, object>} Map of leadId -> feature key/value map
 */
async function batchLoadFeatures(db, leadIds) {
  const featureMap = new Map();
  if (!leadIds || leadIds.length === 0) return featureMap;

  const placeholders = leadIds.map(() => '?').join(',');
  const rows = await db.query(`
    SELECT lead_id, feature_name, feature_value
    FROM feature_store
    WHERE lead_id IN (${placeholders}) AND feature_version = ?
  `, [...leadIds, FEATURE_VERSION]);

  for (const row of rows) {
    if (!featureMap.has(row.lead_id)) {
      featureMap.set(row.lead_id, {});
    }
    featureMap.get(row.lead_id)[row.feature_name] = row.feature_value;
  }
  return featureMap;
}

// ─── getInsightsFromFeatures ────────────────────────────────────────────────

/**
 * Compute insights from a pre-loaded features map (no DB call).
 * @param {object} features - key/value map of feature names to numeric values
 * @returns {Array<{ type: string, message: string, confidence: string }>}
 */
function getInsightsFromFeatures(features) {
  const insights = [];
  if (!features || Object.keys(features).length === 0) return insights;

  // responseTime insights
  if (features.responseTime != null) {
    if (features.responseTime < 5) {
      insights.push({
        type: 'priority',
        message: 'This lead responds quickly — prioritize follow-up within the hour',
        confidence: 'high',
      });
    } else if (features.responseTime > 60) {
      insights.push({
        type: 'warning',
        message: 'Slow responder — schedule follow-ups for their active hours',
        confidence: 'medium',
      });
    }
  }

  // channelDiversity insights
  if (features.channelDiversity != null && features.channelDiversity > 2) {
    insights.push({
      type: 'opportunity',
      message: 'Multi-channel engaged — this is a high-intent lead',
      confidence: 'high',
    });
  }

  // recency insights
  if (features.recency != null && features.recency > 7) {
    insights.push({
      type: 'warning',
      message: 'Gone cold — consider a re-engagement campaign',
      confidence: 'medium',
    });
  }

  // conversionVelocity insights
  if (features.conversionVelocity != null && features.conversionVelocity < 3) {
    insights.push({
      type: 'opportunity',
      message: 'Fast mover — likely to convert soon',
      confidence: 'high',
    });
  }

  // sentimentTrend insights (-1 = declining, 0 = stable, 1 = improving)
  if (features.sentimentTrend != null && features.sentimentTrend === -1) {
    insights.push({
      type: 'warning',
      message: 'Sentiment dropping — may need personal outreach',
      confidence: 'medium',
    });
  }

  return insights;
}

// ─── getLeadInsights ────────────────────────────────────────────────────────

/**
 * Generate actionable insights for a single lead based on its features.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} leadId
 * @param {object} [preloadedFeatures] - optional pre-loaded features to avoid DB call
 * @returns {{ leadId: string, insights: Array<{ type: string, message: string, confidence: string }>, generated_at: string }}
 */
async function getLeadInsights(db, leadId, preloadedFeatures) {
  if (!db || !leadId) {
    return { leadId, insights: [], generated_at: new Date().toISOString() };
  }

  try {
    const features = preloadedFeatures || await loadLeadFeatures(db, leadId);
    const insights = getInsightsFromFeatures(features);

    return {
      leadId,
      insights,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`[leadIntelligence] getLeadInsights failed (${leadId}):`, err.message);
    return { leadId, insights: [], generated_at: new Date().toISOString() };
  }
}

// ─── getClientLeadPriorities ────────────────────────────────────────────────

/**
 * Rank all leads for a client by a composite priority score derived from features.
 *
 * Priority = (1/responseTime * 0.3) + (channelDiversity * 0.2) + (1/recency * 0.3) + (sentimentPositive * 0.2)
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} clientId
 * @returns {Array<{ leadId: string, name: string, phone: string, priorityScore: number, topInsight: string|null }>}
 */
async function getClientLeadPriorities(db, clientId) {
  if (!db || !clientId) return [];

  try {
    const leads = await db.query('SELECT id, name, phone FROM leads WHERE client_id = ?', [clientId]);
    if (leads.length === 0) return [];

    // Batch-load all features in ONE query instead of N per-lead queries
    const leadIds = leads.map(l => l.id);
    const featureMap = await batchLoadFeatures(db, leadIds);

    const scored = [];

    for (const lead of leads) {
      const features = featureMap.get(lead.id) || {};

      // Skip leads with no features at all
      if (Object.keys(features).length === 0) continue;

      // Compute composite priority
      const responseComponent = features.responseTime != null && features.responseTime > 0
        ? (1 / features.responseTime) * 0.3
        : 0;

      const channelComponent = (features.channelDiversity || 0) * 0.2;

      const recencyComponent = features.recency != null && features.recency > 0
        ? (1 / features.recency) * 0.3
        : features.recency === 0 ? 0.3 : 0; // recency 0 means just interacted — max score

      // sentimentTrend: -1 (declining), 0 (stable), 1 (improving)
      // Map to 0-1 range for sentiment positive: (value + 1) / 2
      const sentimentRaw = features.sentimentTrend != null ? features.sentimentTrend : 0;
      const sentimentPositive = (sentimentRaw + 1) / 2;
      const sentimentComponent = sentimentPositive * 0.2;

      const priorityScore = Math.round((responseComponent + channelComponent + recencyComponent + sentimentComponent) * 10000) / 10000;

      // Get top insight using pre-loaded features (no additional DB call)
      const insights = getInsightsFromFeatures(features);
      const topInsight = insights.length > 0 ? insights[0].message : null;

      scored.push({
        leadId: lead.id,
        name: lead.name || 'Unknown',
        phone: lead.phone,
        priorityScore,
        topInsight,
      });
    }

    // Sort descending by priority score, return top 10
    scored.sort((a, b) => b.priorityScore - a.priorityScore);
    return scored.slice(0, 10);
  } catch (err) {
    logger.error(`[leadIntelligence] getClientLeadPriorities failed (${clientId}):`, err.message);
    return [];
  }
}

module.exports = {
  getLeadInsights,
  getClientLeadPriorities,
};
