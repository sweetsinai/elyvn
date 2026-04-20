/**
 * Lead Scoring — Weight Configuration
 *
 * All factor weights and score-band thresholds live here.
 * Changing a number here affects the entire scoring model.
 */

/**
 * Factor weights. Must sum to 1.0.
 *
 * Score = Σ (factor_value * weight)
 */
const WEIGHTS = {
  responsiveness: 0.20,
  engagement:     0.20,
  intent:         0.15,
  recency:        0.15,
  channelDiversity: 0.10,
  aiScore:        0.20,
};

const weightSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(weightSum - 1.0) > 0.001) {
  throw new Error(`[scoring] WEIGHTS must sum to 1.0, got ${weightSum.toFixed(4)}`);
}

/**
 * Score bands for insight / action generation.
 * Bands are inclusive lower bounds, evaluated top-down.
 */
const SCORE_BANDS = {
  HOT:      80,
  WARM:     60,
  MODERATE: 40,
  COLD:     0,
};

/**
 * Recommended-action thresholds (lower bound → action string).
 */
const ACTION_THRESHOLDS = [
  { min: 80, action: 'Call immediately — high conversion probability' },
  { min: 65, action: 'Schedule follow-up call within 2 hours' },
  { min: 50, action: 'Send SMS with specific offer or question' },
  { min: 35, action: 'Schedule follow-up for tomorrow, softer approach' },
];

const ACTION_FALLBACK_STALE   = 'Re-engage with new angle or offer';
const ACTION_FALLBACK_DEFAULT = 'Continue nurturing sequence';

/** Hours threshold after which a lead is considered "stale" for re-engage action */
const STALE_HOURS = 72;

module.exports = {
  WEIGHTS,
  SCORE_BANDS,
  ACTION_THRESHOLDS,
  ACTION_FALLBACK_STALE,
  ACTION_FALLBACK_DEFAULT,
  STALE_HOURS,
};
