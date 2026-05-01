const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validators');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { decrypt } = require('../../utils/encryption');
const { parsePagination } = require('../../utils/dbHelpers');
const { validateQuery, validateParams } = require('../../middleware/validateRequest');
const { MessageQuerySchema, MessageParamsSchema } = require('../../utils/schemas/message');
const { paginated } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /messages/:clientId — migrated to async db.query() for SQLite + Supabase compatibility
router.get('/messages/:clientId', validateParams(MessageParamsSchema), validateQuery(MessageQuerySchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { status, startDate, endDate } = req.query;
    const { page: pageNum, limit: limitNum, offset } = parsePagination(req.query, 20, 100);
    if (isNaN(pageNum) || isNaN(limitNum)) {
      return next(new AppError('INVALID_INPUT', 'Invalid pagination parameters', 400));
    }
    const conditions = [];
    const params = [clientId];

    conditions.push('client_id = ?');

    if (status) {
      conditions.push('direction = ?');
      params.push(status);
    }
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }

    const where = conditions.join(' AND ');

    const countResult = await db.query(`SELECT COUNT(*) as count FROM messages WHERE ${where}`, params, 'get');
    const total = countResult.count;

    const queryParams = [...params, limitNum, offset];
    const messages = await db.query(
      `SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      queryParams, 'all'
    );

    // Gradual encryption migration: prefer decrypted body_encrypted, fall back to plaintext
    for (const msg of messages) {
      if (msg.body_encrypted) {
        try {
          const decrypted = decrypt(msg.body_encrypted);
          if (decrypted && decrypted !== msg.body_encrypted) msg.body = decrypted;
        } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
      }
    }

    return paginated(res, { data: messages, total, limit: limitNum, offset });
  } catch (err) {
    logger.error('[api] messages error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch messages', 500));
  }
});

module.exports = router;
