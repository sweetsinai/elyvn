const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { success } = require('../../utils/response');
const { validateParams } = require('../../middleware/validateRequest');
const { ClientParamsSchema } = require('../../utils/schemas/client');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /schedule/:clientId — AI-generated daily contact schedule
router.get('/schedule/:clientId', validateParams(ClientParamsSchema), (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { generateDailySchedule } = require('../../utils/smartScheduler');
    const schedule = generateDailySchedule(db, clientId);
    return success(res, schedule);
  } catch (err) {
    logger.error('[api] schedule error:', err);
    next(err);
  }
});

// GET /schedule/:clientId/time-slots — Optimal time slot analysis
router.get('/schedule/:clientId/time-slots', validateParams(ClientParamsSchema), (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { analyzeTimeSlotSuccess } = require('../../utils/smartScheduler');
    const analysis = analyzeTimeSlotSuccess(db, clientId);
    return success(res, analysis);
  } catch (err) {
    logger.error('[api] time-slots error:', err);
    next(err);
  }
});

module.exports = router;
