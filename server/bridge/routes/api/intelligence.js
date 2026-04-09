const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { validateParams } = require('../../middleware/validateRequest');
const { ClientParamsSchema } = require('../../utils/schemas/client');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /intelligence/:clientId — Full conversation intelligence report
router.get('/intelligence/:clientId', validateParams(ClientParamsSchema), (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

    const { getConversationIntelligence } = require('../../utils/conversationIntelligence');
    const report = getConversationIntelligence(db, clientId, days);
    return success(res, report);
  } catch (err) {
    logger.error('[api] intelligence error:', err);
    next(err);
  }
});

// GET /intelligence/:clientId/peak-hours — Peak activity hours
router.get('/intelligence/:clientId/peak-hours', validateParams(ClientParamsSchema), (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { getPeakHours } = require('../../utils/conversationIntelligence');
    const peakHours = getPeakHours(db, clientId);
    return success(res, { peak_hours: peakHours });
  } catch (err) {
    logger.error('[api] peak-hours error:', err);
    next(err);
  }
});

// GET /intelligence/:clientId/response-impact — Response time impact analysis
router.get('/intelligence/:clientId/response-impact', validateParams(ClientParamsSchema), (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { analyzeResponseTimeImpact } = require('../../utils/conversationIntelligence');
    const analysis = analyzeResponseTimeImpact(db, clientId);
    return success(res, analysis);
  } catch (err) {
    logger.error('[api] response-impact error:', err);
    next(err);
  }
});

module.exports = router;
