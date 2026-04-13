const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { getBookings } = require('../../utils/calcom');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /bookings/:clientId
router.get('/bookings/:clientId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { startDate, endDate } = req.query;

    // Validate date parameters if provided (ISO 8601 format)
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;
    if (startDate && !isoDateRegex.test(startDate)) {
      return next(new AppError('VALIDATION_ERROR', 'Invalid startDate format. Use ISO 8601 (YYYY-MM-DD)', 400));
    }
    if (endDate && !isoDateRegex.test(endDate)) {
      return next(new AppError('VALIDATION_ERROR', 'Invalid endDate format. Use ISO 8601 (YYYY-MM-DD)', 400));
    }

    const client = await db.query('SELECT calcom_event_type_id FROM clients WHERE id = ?', [clientId], 'get');
    if (!client?.calcom_event_type_id) {
      return success(res, []);
    }

    const bookings = await getBookings(client.calcom_event_type_id, startDate, endDate);
    success(res, bookings);
  } catch (err) {
    logger.error('[api] bookings error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch bookings', 500));
  }
});

module.exports = router;
