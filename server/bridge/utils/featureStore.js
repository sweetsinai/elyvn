/**
 * ML Feature Store — extract, persist, and serve lead features for scoring models
 *
 * Defines a set of feature extractors that compute structured signals from raw
 * interaction data. Features are persisted to the `feature_store` table so they
 * can be served to downstream models without re-computation.
 *
 * Table: feature_store (created in migration 034)
 */

const { randomUUID } = require('crypto');
const { logger } = require('./logger');
const { isAsync } = require('./dbAdapter');

const FEATURE_VERSION = 'v1';

// ─── Individual feature extractors ──────────────────────────────────────────

/**
 * Average time (minutes) between inbound and outbound messages for a lead.
 */
function computeResponseTime(messages) {
  if (!messages || messages.length < 2) return null;

  const pairs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].direction === 'inbound') {
      // Find the next outbound message after this inbound
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].direction === 'outbound') {
          const diff = (new Date(messages[j].created_at) - new Date(messages[i].created_at)) / 60000;
          if (diff > 0 && diff < 10080) { // ignore gaps > 7 days
            pairs.push(diff);
          }
          break;
        }
      }
    }
  }

  if (pairs.length === 0) return null;
  return Math.round((pairs.reduce((a, b) => a + b, 0) / pairs.length) * 100) / 100;
}

/**
 * Total messages in the conversation.
 */
function computeMessageCount(messages) {
  return (messages || []).length;
}

/**
 * Sentiment trend over last 5 call sentiments: improving / declining / stable.
 */
function computeSentimentTrend(calls) {
  const sentiments = (calls || [])
    .filter(c => c.sentiment != null && c.sentiment !== '')
    .map(c => parseFloat(c.sentiment))
    .filter(s => !isNaN(s));

  if (sentiments.length < 2) return 'stable';

  const recent = sentiments.slice(-5);
  // Simple linear slope
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  const n = recent.length;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  if (slope > 0.1) return 'improving';
  if (slope < -0.1) return 'declining';
  return 'stable';
}

/**
 * Number of distinct channels the lead has interacted on (sms, voice, email).
 */
function computeChannelDiversity(messages, calls) {
  const channels = new Set();
  if (calls && calls.length > 0) channels.add('voice');
  for (const msg of (messages || [])) {
    const ch = (msg.channel || 'sms').toLowerCase();
    channels.add(ch);
  }
  return channels.size;
}

/**
 * Days since last interaction.
 */
function computeRecency(messages, calls) {
  let latest = 0;
  for (const m of (messages || [])) {
    const t = new Date(m.created_at).getTime();
    if (t > latest) latest = t;
  }
  for (const c of (calls || [])) {
    const t = new Date(c.created_at).getTime();
    if (t > latest) latest = t;
  }
  if (latest === 0) return null;
  return Math.round(((Date.now() - latest) / 86400000) * 100) / 100;
}

/**
 * Days from lead creation to current stage.
 */
function computeConversionVelocity(lead) {
  if (!lead || !lead.created_at) return null;
  const created = new Date(lead.created_at).getTime();
  const reference = lead.updated_at ? new Date(lead.updated_at).getTime() : Date.now();
  return Math.round(((reference - created) / 86400000) * 100) / 100;
}

// ─── Core exports ───────────────────────────────────────────────────────────

/**
 * Extract all features for a single lead.
 * @param {object} db - better-sqlite3 instance
 * @param {string} leadId
 * @returns {{ leadId, features: object, version: string, computed_at: string }}
 */
async function extractFeatures(db, leadId) {
  if (!db || !leadId) {
    return { leadId, features: {}, version: FEATURE_VERSION, computed_at: new Date().toISOString() };
  }

  try {
    const lead = await db.query('SELECT * FROM leads WHERE id = ?', [leadId], 'get');
    if (!lead) {
      return { leadId, features: {}, version: FEATURE_VERSION, computed_at: new Date().toISOString() };
    }

    const messages = await db.query(
      'SELECT id, direction, channel, body, status, created_at FROM messages WHERE phone = ? AND client_id = ? ORDER BY created_at ASC',
      [lead.phone, lead.client_id]
    );

    const calls = await db.query(
      'SELECT id, duration, outcome, score, sentiment, created_at FROM calls WHERE caller_phone = ? AND client_id = ? ORDER BY created_at ASC',
      [lead.phone, lead.client_id]
    );

    const features = {
      responseTime: computeResponseTime(messages),
      messageCount: computeMessageCount(messages),
      sentimentTrend: computeSentimentTrend(calls),
      channelDiversity: computeChannelDiversity(messages, calls),
      recency: computeRecency(messages, calls),
      conversionVelocity: computeConversionVelocity(lead),
    };

    return {
      leadId,
      features,
      version: FEATURE_VERSION,
      computed_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`[featureStore] extractFeatures failed for lead ${leadId}:`, err.message);
    return { leadId, features: {}, version: FEATURE_VERSION, computed_at: new Date().toISOString() };
  }
}

/**
 * Extract features for all leads belonging to a client.
 * Batch-loads messages and calls for ALL leads upfront to avoid N+1 queries.
 * @param {object} db
 * @param {string} clientId
 * @returns {Array<{ leadId, features, version, computed_at }>}
 */
async function batchExtractFeatures(db, clientId) {
  if (!db || !clientId) return [];

  try {
    const leads = await db.query('SELECT * FROM leads WHERE client_id = ?', [clientId]);
    if (leads.length === 0) return [];

    const phones = leads.map(l => l.phone).filter(Boolean);

    // Batch-load all messages for this client's lead phones in ONE query
    let messagesByPhone = new Map();
    if (phones.length > 0) {
      const phonePlaceholders = phones.map(() => '?').join(',');
      const allMessages = await db.query(
        `SELECT id, direction, channel, body, status, created_at, phone FROM messages WHERE phone IN (${phonePlaceholders}) AND client_id = ? ORDER BY created_at ASC`,
        [...phones, clientId]
      );
      for (const msg of allMessages) {
        if (!messagesByPhone.has(msg.phone)) {
          messagesByPhone.set(msg.phone, []);
        }
        messagesByPhone.get(msg.phone).push(msg);
      }
    }

    // Batch-load all calls for this client's lead phones in ONE query
    let callsByPhone = new Map();
    if (phones.length > 0) {
      const phonePlaceholders = phones.map(() => '?').join(',');
      const allCalls = await db.query(
        `SELECT id, duration, outcome, score, sentiment, created_at, caller_phone FROM calls WHERE caller_phone IN (${phonePlaceholders}) AND client_id = ? ORDER BY created_at ASC`,
        [...phones, clientId]
      );
      for (const call of allCalls) {
        if (!callsByPhone.has(call.caller_phone)) {
          callsByPhone.set(call.caller_phone, []);
        }
        callsByPhone.get(call.caller_phone).push(call);
      }
    }

    // Compute features from pre-loaded batch data
    const results = [];
    for (const lead of leads) {
      const messages = messagesByPhone.get(lead.phone) || [];
      const calls = callsByPhone.get(lead.phone) || [];

      const features = {
        responseTime: computeResponseTime(messages),
        messageCount: computeMessageCount(messages),
        sentimentTrend: computeSentimentTrend(calls),
        channelDiversity: computeChannelDiversity(messages, calls),
        recency: computeRecency(messages, calls),
        conversionVelocity: computeConversionVelocity(lead),
      };

      results.push({
        leadId: lead.id,
        features,
        version: FEATURE_VERSION,
        computed_at: new Date().toISOString(),
      });
    }
    return results;
  } catch (err) {
    logger.error(`[featureStore] batchExtractFeatures failed for client ${clientId}:`, err.message);
    return [];
  }
}

/**
 * Persist extracted features into the feature_store table (upsert).
 * @param {object} db
 * @param {string} leadId
 * @param {object} features - key/value map of feature names to values
 */
async function persistFeatures(db, leadId, features) {
  if (!db || !leadId || !features) return;

  // Convert non-numeric values to a numeric representation
  function toNumeric(value) {
    if (typeof value === 'number') return value;
    if (value === null || value === undefined) return null;
    if (value === 'improving') return 1;
    if (value === 'stable') return 0;
    if (value === 'declining') return -1;
    return 0;
  }

  try {
    const entries = Object.entries(features);
    const upsertSQL = `
      INSERT INTO feature_store (id, lead_id, feature_name, feature_value, feature_version, computed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(lead_id, feature_name, feature_version) DO UPDATE SET
        feature_value = excluded.feature_value,
        computed_at = excluded.computed_at
    `;

    if (isAsync(db)) {
      // Postgres: single batch INSERT ... ON CONFLICT (1 round-trip instead of N)
      const placeholders = entries.map((_, i) => {
        const base = i * 5;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, NOW())`;
      }).join(', ');
      const params = entries.flatMap(([name, value]) => [
        randomUUID(), leadId, name, toNumeric(value), FEATURE_VERSION,
      ]);
      await db.query(`
        INSERT INTO feature_store (id, lead_id, feature_name, feature_value, feature_version, computed_at)
        VALUES ${placeholders}
        ON CONFLICT(lead_id, feature_name, feature_version) DO UPDATE SET
          feature_value = excluded.feature_value,
          computed_at = excluded.computed_at
      `, params, 'run');
    } else {
      // SQLite: sync transaction
      const upsert = db.prepare(upsertSQL);
      const insertAll = db.transaction((items) => {
        for (const [name, value] of items) {
          upsert.run(randomUUID(), leadId, name, toNumeric(value), FEATURE_VERSION);
        }
      });
      insertAll(entries);
    }
  } catch (err) {
    logger.error(`[featureStore] persistFeatures failed for lead ${leadId}:`, err.message);
  }
}

/**
 * Check for leads with stale (outdated) features.
 * @param {object} db - better-sqlite3 instance
 * @param {string} clientId
 * @param {number} [maxAgeDays=7] - Features older than this are considered stale
 * @returns {Promise<Array<{ lead_id: string, oldest: string }>>}
 */
async function checkFeatureStaleness(db, clientId, maxAgeDays = 7) {
  if (!db || !clientId) return [];

  try {
    const rows = await db.query(`
      SELECT lead_id, MIN(computed_at) as oldest FROM feature_store
      WHERE lead_id IN (SELECT id FROM leads WHERE client_id = ? AND stage NOT IN ('lost','not_interested'))
      GROUP BY lead_id HAVING oldest < datetime('now', '-' || ? || ' days')
    `, [clientId, maxAgeDays]);

    return rows || [];
  } catch (err) {
    logger.error(`[featureStore] checkFeatureStaleness failed for client ${clientId}:`, err.message);
    return [];
  }
}

module.exports = {
  extractFeatures,
  batchExtractFeatures,
  persistFeatures,
  checkFeatureStaleness,
};
