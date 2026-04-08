/**
 * A/B Testing Infrastructure — Server-Side Experiments
 *
 * Manages experiments (e.g., different AI response tones, follow-up timing).
 * Uses deterministic hashing for stable variant assignment and stores outcomes
 * for statistical analysis.
 *
 * Tables: experiments, experiment_assignments, experiment_outcomes (migration 035)
 */

const { randomUUID, createHash } = require('crypto');
const { logger } = require('./logger');

/**
 * Assign a variant to a subject for a given experiment.
 * Deterministic — same subject always gets the same variant.
 * Respects variant weights. Inserts into experiment_assignments if new.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} experimentName
 * @param {string} subjectId - lead ID or phone number
 * @returns {{ variantId: string, isNew: boolean } | null}
 */
async function assignVariant(db, experimentName, subjectId) {
  if (!db || !experimentName || !subjectId) return null;

  try {
    const experiment = await db.query(
      "SELECT * FROM experiments WHERE name = ? AND status = 'active'",
      [experimentName], 'get'
    );
    if (!experiment) return null;

    // Check for existing assignment
    const existing = await db.query(
      'SELECT variant_id FROM experiment_assignments WHERE experiment_id = ? AND subject_id = ?',
      [experiment.id, subjectId], 'get'
    );
    if (existing) {
      return { variantId: existing.variant_id, isNew: false };
    }

    // Parse variants JSON: [{ id, weight }, ...]
    let variants;
    try {
      variants = JSON.parse(experiment.variants);
    } catch {
      logger.error(`[experiments] Invalid variants JSON for experiment ${experimentName}`);
      return null;
    }

    if (!variants || variants.length === 0) return null;

    // Deterministic assignment via hash
    const hash = createHash('sha256')
      .update(`${experiment.id}:${subjectId}`)
      .digest();
    // Use first 4 bytes as a 32-bit unsigned int
    const hashValue = hash.readUInt32BE(0);

    // Weighted selection
    const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 1), 0);
    const threshold = (hashValue / 0xFFFFFFFF) * totalWeight;

    let cumulative = 0;
    let selectedVariant = variants[0].id;
    for (const v of variants) {
      cumulative += (v.weight || 1);
      if (threshold <= cumulative) {
        selectedVariant = v.id;
        break;
      }
    }

    // Persist assignment
    await db.query(
      'INSERT INTO experiment_assignments (id, experiment_id, subject_id, variant_id) VALUES (?, ?, ?, ?)',
      [randomUUID(), experiment.id, subjectId, selectedVariant], 'run'
    );

    return { variantId: selectedVariant, isNew: true };
  } catch (err) {
    logger.error(`[experiments] assignVariant failed (${experimentName}, ${subjectId}):`, err.message);
    return null;
  }
}

/**
 * Record an outcome for a subject in an experiment.
 *
 * @param {object} db
 * @param {string} experimentName
 * @param {string} subjectId
 * @param {string} outcome - 'converted', 'replied', 'booked', etc.
 * @returns {boolean}
 */
async function recordOutcome(db, experimentName, subjectId, outcome) {
  if (!db || !experimentName || !subjectId || !outcome) return false;

  try {
    const experiment = await db.query('SELECT id FROM experiments WHERE name = ?', [experimentName], 'get');
    if (!experiment) return false;

    // Look up the subject's variant
    const assignment = await db.query(
      'SELECT variant_id FROM experiment_assignments WHERE experiment_id = ? AND subject_id = ?',
      [experiment.id, subjectId], 'get'
    );
    if (!assignment) return false;

    await db.query(
      'INSERT INTO experiment_outcomes (id, experiment_id, subject_id, variant_id, outcome) VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), experiment.id, subjectId, assignment.variant_id, outcome], 'run'
    );

    return true;
  } catch (err) {
    logger.error(`[experiments] recordOutcome failed (${experimentName}, ${subjectId}):`, err.message);
    return false;
  }
}

/**
 * Aggregate experiment results with conversion rates and z-test significance.
 *
 * @param {object} db
 * @param {string} experimentName
 * @returns {{ experiment: object, variants: Array<{ id, assignments, outcomes, conversion_rate }>, significance: object | null }}
 */
async function getExperimentResults(db, experimentName) {
  if (!db || !experimentName) return null;

  try {
    const experiment = await db.query('SELECT * FROM experiments WHERE name = ?', [experimentName], 'get');
    if (!experiment) return null;

    let variants;
    try {
      variants = JSON.parse(experiment.variants);
    } catch {
      variants = [];
    }

    const results = [];
    for (const v of variants) {
      const assignmentRow = await db.query(
        'SELECT COUNT(*) as c FROM experiment_assignments WHERE experiment_id = ? AND variant_id = ?',
        [experiment.id, v.id], 'get'
      );
      const assignmentCount = assignmentRow?.c || 0;

      const outcomeRow = await db.query(
        'SELECT COUNT(DISTINCT subject_id) as c FROM experiment_outcomes WHERE experiment_id = ? AND variant_id = ?',
        [experiment.id, v.id], 'get'
      );
      const outcomeCount = outcomeRow?.c || 0;

      const outcomeCounts = await db.query(
        'SELECT outcome, COUNT(*) as c FROM experiment_outcomes WHERE experiment_id = ? AND variant_id = ? GROUP BY outcome',
        [experiment.id, v.id]
      );

      results.push({
        id: v.id,
        weight: v.weight || 1,
        assignments: assignmentCount,
        unique_outcomes: outcomeCount,
        conversion_rate: assignmentCount > 0
          ? Math.round((outcomeCount / assignmentCount) * 10000) / 100
          : 0,
        outcome_breakdown: Object.fromEntries(outcomeCounts.map(r => [r.outcome, r.c])),
      });
    }

    // Z-test for significance (only meaningful with 2 variants)
    let significance = null;
    if (results.length === 2) {
      const [a, b] = results;
      if (a.assignments > 0 && b.assignments > 0) {
        const pA = a.unique_outcomes / a.assignments;
        const pB = b.unique_outcomes / b.assignments;
        const pPool = (a.unique_outcomes + b.unique_outcomes) / (a.assignments + b.assignments);
        const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.assignments + 1 / b.assignments));

        if (se > 0) {
          const z = (pA - pB) / se;
          const pValue = 2 * (1 - normalCDF(Math.abs(z)));
          significance = {
            z_score: Math.round(z * 1000) / 1000,
            p_value: Math.round(pValue * 10000) / 10000,
            significant_at_95: pValue < 0.05,
            significant_at_99: pValue < 0.01,
            winner: pValue < 0.05 ? (pA > pB ? a.id : b.id) : null,
          };
        }
      }
    }

    return {
      experiment: {
        id: experiment.id,
        name: experiment.name,
        status: experiment.status,
        created_at: experiment.created_at,
      },
      variants: results,
      significance,
    };
  } catch (err) {
    logger.error(`[experiments] getExperimentResults failed (${experimentName}):`, err.message);
    return null;
  }
}

/**
 * List all experiments (optionally filtered by status).
 * @param {object} db
 * @param {string} [status] - 'active', 'paused', 'completed'
 * @returns {Array}
 */
async function listExperiments(db, status) {
  if (!db) return [];
  try {
    if (status) {
      return await db.query('SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC', [status]);
    }
    return await db.query('SELECT * FROM experiments ORDER BY created_at DESC');
  } catch (err) {
    logger.error('[experiments] listExperiments failed:', err.message);
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Approximate normal CDF using Abramowitz & Stegun formula.
 */
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

module.exports = {
  assignVariant,
  recordOutcome,
  getExperimentResults,
  listExperiments,
};
