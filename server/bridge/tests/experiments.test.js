/**
 * Tests for utils/experiments.js
 *
 * Functions under test:
 *   - assignVariant   — deterministic A/B assignment with weighted selection
 *   - recordOutcome   — persist conversion / outcome events
 *   - getExperimentResults — aggregate stats + z-test significance
 *   - listExperiments — list all or filtered by status
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

const { assignVariant, recordOutcome, getExperimentResults, listExperiments } = require('../utils/experiments');
const { logger } = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(opts = {}) {
  const {
    experiment = null,
    existingAssignment = null,
    insertResult = { changes: 1 },
    countResults = {},   // variant_id → { assignments, outcomes, breakdown }
    outcomesAll = [],
  } = opts;

  return {
    query: jest.fn(async (sql, params = [], mode = 'all') => {
      // Fetch active experiment (assignVariant uses status = 'active')
      if (sql.includes("FROM experiments WHERE name") && sql.includes("status = 'active'")) {
        return experiment;
      }
      // Fetch any experiment (recordOutcome / getResults — no status filter)
      if (sql.includes("FROM experiments WHERE name") && !sql.includes("status = 'active'")) {
        return experiment;
      }
      // Assignment count per variant — must check BEFORE the plain assignment lookup
      if (sql.includes('COUNT(*) as c FROM experiment_assignments')) {
        const variant = params[1];
        return { c: countResults[variant]?.assignments ?? 0 };
      }
      // Outcome count per variant (DISTINCT subject_id)
      if (sql.includes('COUNT(DISTINCT subject_id) as c FROM experiment_outcomes')) {
        const variant = params[1];
        return { c: countResults[variant]?.outcomes ?? 0 };
      }
      // Outcome breakdown per variant
      if (sql.includes('outcome, COUNT(*) as c FROM experiment_outcomes') && mode === 'all') {
        return outcomesAll;
      }
      // Plain assignment lookup (assignVariant + recordOutcome check)
      if (sql.includes('FROM experiment_assignments WHERE experiment_id') && mode === 'get') {
        return existingAssignment;
      }
      // Insert assignment or outcome
      if (sql.includes('INSERT INTO experiment_assignments') || sql.includes('INSERT INTO experiment_outcomes')) {
        return insertResult;
      }
      // listExperiments (no WHERE on name)
      if (sql.includes('FROM experiments') && !sql.includes('WHERE name')) {
        if (sql.includes('WHERE status')) {
          return [{ id: 'exp1', name: 'test', status: params[0] }];
        }
        return [{ id: 'exp1', name: 'test', status: 'active' }];
      }
      if (mode === 'get') return undefined;
      return [];
    }),
  };
}

const ACTIVE_EXPERIMENT = {
  id: 'exp1',
  name: 'tone_test',
  status: 'active',
  variants: JSON.stringify([
    { id: 'control', weight: 1 },
    { id: 'variant_a', weight: 1 },
  ]),
  created_at: '2026-01-01T00:00:00Z',
};

// ─── assignVariant ────────────────────────────────────────────────────────────

describe('assignVariant', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when db is missing', async () => {
    const result = await assignVariant(null, 'tone_test', 'lead1');
    expect(result).toBeNull();
  });

  it('returns null when experimentName is missing', async () => {
    const db = makeDb({ experiment: ACTIVE_EXPERIMENT });
    const result = await assignVariant(db, '', 'lead1');
    expect(result).toBeNull();
  });

  it('returns null when subjectId is missing', async () => {
    const db = makeDb({ experiment: ACTIVE_EXPERIMENT });
    const result = await assignVariant(db, 'tone_test', '');
    expect(result).toBeNull();
  });

  it('returns null when experiment not found', async () => {
    const db = makeDb({ experiment: null });
    const result = await assignVariant(db, 'nonexistent', 'lead1');
    expect(result).toBeNull();
  });

  it('returns existing assignment without inserting a new one', async () => {
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      existingAssignment: { variant_id: 'control' },
    });

    const result = await assignVariant(db, 'tone_test', 'lead1');

    expect(result).toEqual({ variantId: 'control', isNew: false });
    // No INSERT should have happened
    const insertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO experiment_assignments'));
    expect(insertCalls).toHaveLength(0);
  });

  it('assigns a new variant and persists the assignment', async () => {
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      existingAssignment: null,
    });

    const result = await assignVariant(db, 'tone_test', 'lead1');

    expect(result).not.toBeNull();
    expect(['control', 'variant_a']).toContain(result.variantId);
    expect(result.isNew).toBe(true);

    const insertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO experiment_assignments'));
    expect(insertCalls).toHaveLength(1);
  });

  it('is deterministic — same subject always gets same variant', async () => {
    const db1 = makeDb({ experiment: ACTIVE_EXPERIMENT, existingAssignment: null });
    const db2 = makeDb({ experiment: ACTIVE_EXPERIMENT, existingAssignment: null });

    const r1 = await assignVariant(db1, 'tone_test', 'stable-subject-123');
    const r2 = await assignVariant(db2, 'tone_test', 'stable-subject-123');

    expect(r1.variantId).toBe(r2.variantId);
  });

  it('different subjects can land on different variants', async () => {
    const variants = new Set();
    for (let i = 0; i < 20; i++) {
      const db = makeDb({ experiment: ACTIVE_EXPERIMENT, existingAssignment: null });
      const r = await assignVariant(db, 'tone_test', `subject-${i}`);
      variants.add(r.variantId);
    }
    // With 20 subjects we expect to see both variants
    expect(variants.size).toBeGreaterThan(1);
  });

  it('returns null for invalid variants JSON', async () => {
    const db = makeDb({
      experiment: { ...ACTIVE_EXPERIMENT, variants: '{bad json' },
      existingAssignment: null,
    });

    const result = await assignVariant(db, 'tone_test', 'lead1');

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid variants JSON')
    );
  });

  it('returns null for empty variants array', async () => {
    const db = makeDb({
      experiment: { ...ACTIVE_EXPERIMENT, variants: '[]' },
      existingAssignment: null,
    });

    const result = await assignVariant(db, 'tone_test', 'lead1');
    expect(result).toBeNull();
  });

  it('returns null and logs on DB error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('DB down')) };

    const result = await assignVariant(db, 'tone_test', 'lead1');

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('assignVariant failed'),
      'DB down'
    );
  });

  it('respects variant weights in assignment distribution', async () => {
    const weightedExperiment = {
      ...ACTIVE_EXPERIMENT,
      variants: JSON.stringify([
        { id: 'control', weight: 9 },
        { id: 'treatment', weight: 1 },
      ]),
    };

    const assignments = { control: 0, treatment: 0 };
    for (let i = 0; i < 100; i++) {
      const db = makeDb({ experiment: weightedExperiment, existingAssignment: null });
      const r = await assignVariant(db, 'tone_test', `w-subject-${i}`);
      assignments[r.variantId] = (assignments[r.variantId] || 0) + 1;
    }

    // With 90/10 weight split, control should dominate
    expect(assignments.control).toBeGreaterThan(assignments.treatment);
  });
});

// ─── recordOutcome ────────────────────────────────────────────────────────────

describe('recordOutcome', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns false when any required param is missing', async () => {
    const db = makeDb({ experiment: ACTIVE_EXPERIMENT });
    expect(await recordOutcome(null, 'e', 's', 'converted')).toBe(false);
    expect(await recordOutcome(db, '', 's', 'converted')).toBe(false);
    expect(await recordOutcome(db, 'e', '', 'converted')).toBe(false);
    expect(await recordOutcome(db, 'e', 's', '')).toBe(false);
  });

  it('returns false when experiment not found', async () => {
    const db = makeDb({ experiment: null });
    const result = await recordOutcome(db, 'nonexistent', 'lead1', 'converted');
    expect(result).toBe(false);
  });

  it('returns false when subject has no assignment', async () => {
    const db = makeDb({ experiment: ACTIVE_EXPERIMENT, existingAssignment: null });
    const result = await recordOutcome(db, 'tone_test', 'unassigned-lead', 'converted');
    expect(result).toBe(false);
  });

  it('inserts outcome and returns true', async () => {
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      existingAssignment: { variant_id: 'control' },
    });

    const result = await recordOutcome(db, 'tone_test', 'lead1', 'converted');

    expect(result).toBe(true);
    const insertCalls = db.query.mock.calls.filter(c => c[0].includes('INSERT INTO experiment_outcomes'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual(
      expect.arrayContaining(['exp1', 'lead1', 'control', 'converted'])
    );
  });

  it('returns false and logs on DB error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('Write error')) };

    const result = await recordOutcome(db, 'tone_test', 'lead1', 'converted');

    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('recordOutcome failed'),
      'Write error'
    );
  });

  it('records various outcome types', async () => {
    const outcomes = ['converted', 'replied', 'booked', 'no_show'];

    for (const outcome of outcomes) {
      const db = makeDb({
        experiment: ACTIVE_EXPERIMENT,
        existingAssignment: { variant_id: 'control' },
      });

      const result = await recordOutcome(db, 'tone_test', 'lead1', outcome);
      expect(result).toBe(true);
    }
  });
});

// ─── getExperimentResults ─────────────────────────────────────────────────────

describe('getExperimentResults', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when db is missing', async () => {
    expect(await getExperimentResults(null, 'tone_test')).toBeNull();
  });

  it('returns null when experimentName is missing', async () => {
    expect(await getExperimentResults(makeDb(), '')).toBeNull();
  });

  it('returns null when experiment not found', async () => {
    const db = makeDb({ experiment: null });
    const result = await getExperimentResults(db, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns experiment results with zero conversion when no data', async () => {
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      countResults: {
        control: { assignments: 0, outcomes: 0 },
        variant_a: { assignments: 0, outcomes: 0 },
      },
    });

    const result = await getExperimentResults(db, 'tone_test');

    expect(result).not.toBeNull();
    expect(result.experiment.name).toBe('tone_test');
    expect(result.variants).toHaveLength(2);
    result.variants.forEach(v => {
      expect(v.conversion_rate).toBe(0);
    });
    expect(result.significance).toBeNull();
  });

  it('calculates conversion rates correctly', async () => {
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      countResults: {
        control: { assignments: 100, outcomes: 20 },
        variant_a: { assignments: 100, outcomes: 30 },
      },
    });

    const result = await getExperimentResults(db, 'tone_test');

    const ctrl = result.variants.find(v => v.id === 'control');
    const va = result.variants.find(v => v.id === 'variant_a');

    expect(ctrl.conversion_rate).toBe(20); // 20/100 = 20%
    expect(va.conversion_rate).toBe(30);   // 30/100 = 30%
  });

  it('computes z-test significance for 2-variant experiment', async () => {
    // Large sample, clear winner → significant
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      countResults: {
        control: { assignments: 1000, outcomes: 100 },
        variant_a: { assignments: 1000, outcomes: 250 },
      },
    });

    const result = await getExperimentResults(db, 'tone_test');

    expect(result.significance).not.toBeNull();
    expect(typeof result.significance.z_score).toBe('number');
    expect(typeof result.significance.p_value).toBe('number');
    expect(result.significance.significant_at_95).toBe(true);
    expect(result.significance.winner).toBe('variant_a'); // higher conversion
  });

  it('reports not significant when samples are too small', async () => {
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      countResults: {
        control: { assignments: 5, outcomes: 2 },
        variant_a: { assignments: 5, outcomes: 3 },
      },
    });

    const result = await getExperimentResults(db, 'tone_test');

    expect(result.significance).not.toBeNull();
    expect(result.significance.significant_at_95).toBe(false);
    expect(result.significance.winner).toBeNull();
  });

  it('does not compute significance for single-variant experiments', async () => {
    const singleVariantExp = {
      ...ACTIVE_EXPERIMENT,
      variants: JSON.stringify([{ id: 'control', weight: 1 }]),
    };
    const db = makeDb({
      experiment: singleVariantExp,
      countResults: { control: { assignments: 100, outcomes: 20 } },
    });

    const result = await getExperimentResults(db, 'tone_test');

    expect(result.significance).toBeNull();
    expect(result.variants).toHaveLength(1);
  });

  it('returns null and logs on DB error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('Query failed')) };

    const result = await getExperimentResults(db, 'tone_test');

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('getExperimentResults failed'),
      'Query failed'
    );
  });

  it('handles invalid variants JSON gracefully in results', async () => {
    const db = makeDb({
      experiment: { ...ACTIVE_EXPERIMENT, variants: 'not-json' },
    });

    const result = await getExperimentResults(db, 'tone_test');

    expect(result).not.toBeNull();
    expect(result.variants).toEqual([]);
  });

  it('includes outcome breakdown in results', async () => {
    const db = makeDb({
      experiment: ACTIVE_EXPERIMENT,
      countResults: {
        control: { assignments: 50, outcomes: 10 },
        variant_a: { assignments: 50, outcomes: 15 },
      },
      outcomesAll: [
        { outcome: 'converted', c: 8 },
        { outcome: 'booked', c: 2 },
      ],
    });

    const result = await getExperimentResults(db, 'tone_test');

    const ctrl = result.variants.find(v => v.id === 'control');
    expect(ctrl.outcome_breakdown).toMatchObject({ converted: 8, booked: 2 });
  });
});

// ─── listExperiments ──────────────────────────────────────────────────────────

describe('listExperiments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty array when db is null', async () => {
    const result = await listExperiments(null);
    expect(result).toEqual([]);
  });

  it('returns all experiments when no status filter given', async () => {
    const db = makeDb({ experiment: ACTIVE_EXPERIMENT });

    const result = await listExperiments(db);

    expect(Array.isArray(result)).toBe(true);
    // At least the query was executed without a status param
    const calls = db.query.mock.calls;
    const listCall = calls.find(c => c[0].includes('FROM experiments') && !c[0].includes('WHERE name'));
    expect(listCall).toBeDefined();
  });

  it('filters by status when provided', async () => {
    const db = makeDb({ experiment: ACTIVE_EXPERIMENT });

    await listExperiments(db, 'active');

    const calls = db.query.mock.calls;
    const statusCall = calls.find(c => c[0].includes('WHERE status'));
    expect(statusCall).toBeDefined();
    expect(statusCall[1]).toEqual(['active']);
  });

  it('returns empty array on DB error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('DB gone')) };

    const result = await listExperiments(db, 'active');

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('listExperiments failed'),
      'DB gone'
    );
  });
});
