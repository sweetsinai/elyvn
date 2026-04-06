const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { isValidUUID } = require('../../utils/validate');

// GET /revenue/:clientId — Revenue attribution & ROI
router.get('/revenue/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

    const { getROIMetrics } = require('../../utils/revenueAttribution');
    const metrics = getROIMetrics(db, clientId, days);
    res.json({ data: metrics });
  } catch (err) {
    logger.error('[api] revenue error:', err);
    res.status(500).json({ error: 'Failed to get revenue metrics' });
  }
});

// GET /revenue/:clientId/:leadId — Single lead attribution chain
router.get('/revenue/:clientId/:leadId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return res.status(400).json({ error: 'Invalid client ID or lead ID' });
    }

    const { getAttribution } = require('../../utils/revenueAttribution');
    const attribution = getAttribution(db, leadId, clientId);
    res.json({ data: attribution });
  } catch (err) {
    logger.error('[api] attribution error:', err);
    res.status(500).json({ error: 'Failed to get lead attribution' });
  }
});

// GET /revenue/:clientId/channels/performance — Channel performance breakdown
router.get('/revenue/:clientId/channels/performance', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const { getChannelPerformance } = require('../../utils/revenueAttribution');
    const channels = getChannelPerformance(db, clientId);
    res.json({ data: channels });
  } catch (err) {
    logger.error('[api] channel performance error:', err);
    res.status(500).json({ error: 'Failed to get channel performance' });
  }
});

module.exports = router;
