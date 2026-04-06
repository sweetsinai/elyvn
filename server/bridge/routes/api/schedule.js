const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');

// GET /schedule/:clientId — AI-generated daily contact schedule
router.get('/schedule/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { generateDailySchedule } = require('../../utils/smartScheduler');
    const schedule = generateDailySchedule(db, clientId);
    res.json({ schedule, total: schedule.length });
  } catch (err) {
    logger.error('[api] schedule error:', err);
    res.status(500).json({ error: 'Failed to generate schedule' });
  }
});

// GET /schedule/:clientId/time-slots — Optimal time slot analysis
router.get('/schedule/:clientId/time-slots', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { analyzeTimeSlotSuccess } = require('../../utils/smartScheduler');
    const analysis = analyzeTimeSlotSuccess(db, clientId);
    res.json(analysis);
  } catch (err) {
    logger.error('[api] time-slots error:', err);
    res.status(500).json({ error: 'Failed to analyze time slots' });
  }
});

module.exports = router;
