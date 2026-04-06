const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');

// GET /reports/:clientId
router.get('/reports/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const reports = db.prepare(
      'SELECT * FROM weekly_reports WHERE client_id = ? ORDER BY created_at DESC LIMIT 12'
    ).all(clientId);

    res.json({ reports });
  } catch (err) {
    logger.error('[api] reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

module.exports = router;
