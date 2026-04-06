const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');

// GET /scoring/:clientId — Batch predictive scores for all active leads
router.get('/scoring/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { batchScoreLeads } = require('../../utils/leadScoring');
    const scores = batchScoreLeads(db, clientId);
    res.json({ leads: scores, total: scores.length });
  } catch (err) {
    logger.error('[api] scoring error:', err);
    res.status(500).json({ error: 'Failed to score leads' });
  }
});

// GET /scoring/:clientId/:leadId — Individual lead predictive score
router.get('/scoring/:clientId/:leadId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    const { predictLeadScore } = require('../../utils/leadScoring');
    const score = predictLeadScore(db, leadId, clientId);
    res.json(score);
  } catch (err) {
    logger.error('[api] lead score error:', err);
    res.status(500).json({ error: 'Failed to score lead' });
  }
});

// GET /scoring/:clientId/analytics/conversion — Conversion analytics
router.get('/scoring/:clientId/analytics/conversion', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { getConversionAnalytics } = require('../../utils/leadScoring');
    const analytics = getConversionAnalytics(db, clientId);
    res.json(analytics);
  } catch (err) {
    logger.error('[api] conversion analytics error:', err);
    res.status(500).json({ error: 'Failed to get conversion analytics' });
  }
});

module.exports = router;
