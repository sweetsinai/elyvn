const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { getBookings } = require('../../utils/calcom');
const { logger } = require('../../utils/logger');

// GET /bookings/:clientId
router.get('/bookings/:clientId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const { startDate, endDate } = req.query;

    // Validate date parameters if provided (ISO 8601 format)
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;
    if (startDate && !isoDateRegex.test(startDate)) {
      return res.status(400).json({ error: 'Invalid startDate format. Use ISO 8601 (YYYY-MM-DD)' });
    }
    if (endDate && !isoDateRegex.test(endDate)) {
      return res.status(400).json({ error: 'Invalid endDate format. Use ISO 8601 (YYYY-MM-DD)' });
    }

    const client = db.prepare('SELECT calcom_event_type_id FROM clients WHERE id = ?').get(clientId);
    if (!client?.calcom_event_type_id) {
      return res.json({ bookings: [] });
    }

    const bookings = await getBookings(client.calcom_event_type_id, startDate, endDate);
    res.json({ bookings });
  } catch (err) {
    logger.error('[api] bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

module.exports = router;
