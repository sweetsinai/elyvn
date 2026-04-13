const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { isValidUUID } = require('../../utils/validate');
const { success } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /scoring/:clientId — Batch predictive scores for all active leads
router.get('/scoring/:clientId', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));
    }

    const { batchScoreLeads } = require('../../utils/leadScoring');
    const scores = batchScoreLeads(db, clientId);
    success(res, { scores, meta: { total: scores.length } });
  } catch (err) {
    logger.error('[api] scoring error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to score leads', 500));
  }
});

// GET /scoring/:clientId/:leadId — Individual lead predictive score with factor breakdown
router.get('/scoring/:clientId/:leadId', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID or lead ID', 400));
    }

    const { predictLeadScore } = require('../../utils/leadScoring');
    const result = predictLeadScore(db, leadId, clientId);

    // Return full factor breakdown + model version so callers can display explainability
    success(res, {
      score: result.score,
      factors: result.factors,          // { responsiveness, engagement, intent, recency, channelDiversity }
      insight: result.insight,
      recommended_action: result.recommended_action,
      details: result.details,
      model_version: result.model_version,
    });
  } catch (err) {
    logger.error('[api] lead score error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to score lead', 500));
  }
});

// GET /scoring/:clientId/analytics/conversion — Conversion analytics
router.get('/scoring/:clientId/analytics/conversion', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));
    }

    const { getConversionAnalytics } = require('../../utils/leadScoring');
    const analytics = getConversionAnalytics(db, clientId);
    success(res, analytics);
  } catch (err) {
    logger.error('[api] conversion analytics error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get conversion analytics', 500));
  }
});

// GET /scoring/:clientId/:leadId/insights — Feature-derived intelligence for a lead
router.get('/scoring/:clientId/:leadId/insights', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID or lead ID', 400));
    }

    const { getLeadInsights } = require('../../utils/leadIntelligence');
    const insights = await getLeadInsights(db, leadId, null, clientId);
    success(res, insights);
  } catch (err) {
    logger.error('[api] lead insights error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get lead insights', 500));
  }
});

module.exports = router;
