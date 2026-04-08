const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { isValidUUID } = require('../../utils/validate');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /intelligence/:clientId — Full conversation intelligence report
router.get('/intelligence/:clientId', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

    const { getConversationIntelligence } = require('../../utils/conversationIntelligence');
    const report = getConversationIntelligence(db, clientId, days);
    res.json({ data: report });
  } catch (err) {
    logger.error('[api] intelligence error:', err);
    next(err);
  }
});

// GET /intelligence/:clientId/peak-hours — Peak activity hours
router.get('/intelligence/:clientId/peak-hours', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const { getPeakHours } = require('../../utils/conversationIntelligence');
    const peakHours = getPeakHours(db, clientId);
    res.json({ data: { peak_hours: peakHours } });
  } catch (err) {
    logger.error('[api] peak-hours error:', err);
    next(err);
  }
});

// GET /intelligence/:clientId/response-impact — Response time impact analysis
router.get('/intelligence/:clientId/response-impact', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const { analyzeResponseTimeImpact } = require('../../utils/conversationIntelligence');
    const analysis = analyzeResponseTimeImpact(db, clientId);
    res.json({ data: analysis });
  } catch (err) {
    logger.error('[api] response-impact error:', err);
    next(err);
  }
});

module.exports = router;
