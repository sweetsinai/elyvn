const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');

// GET /messages/:clientId
router.get('/messages/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const { status, startDate, endDate } = req.query;
    const pageNum = Math.max(1, Math.min(10000, parseInt(req.query.page) || 1));
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    if (isNaN(pageNum) || isNaN(limitNum)) {
      return res.status(400).json({ error: 'Invalid pagination parameters' });
    }
    const offset = (pageNum - 1) * limitNum;
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

    const countParams = [...params];
    const total = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE ${where}`).get(...countParams).count;

    const queryParams = [...params, limitNum, offset];
    const messages = db.prepare(
      `SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...queryParams);

    const totalPages = Math.ceil(total / limitNum);
    res.json({ data: messages, meta: { page: pageNum, limit: limitNum, total, total_pages: totalPages } });
  } catch (err) {
    logger.error('[api] messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

module.exports = router;
