const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { isValidUUID } = require('../../utils/validate');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /schedule/:clientId — AI-generated daily contact schedule
router.get('/schedule/:clientId', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const { generateDailySchedule } = require('../../utils/smartScheduler');
    const schedule = generateDailySchedule(db, clientId);
    res.json({ data: schedule, meta: { total: schedule.length } });
  } catch (err) {
    logger.error('[api] schedule error:', err);
    next(err);
  }
});

// GET /schedule/:clientId/time-slots — Optimal time slot analysis
router.get('/schedule/:clientId/time-slots', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const { analyzeTimeSlotSuccess } = require('../../utils/smartScheduler');
    const analysis = analyzeTimeSlotSuccess(db, clientId);
    res.json({ data: analysis });
  } catch (err) {
    logger.error('[api] time-slots error:', err);
    next(err);
  }
});

module.exports = router;
