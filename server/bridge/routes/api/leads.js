const express = require('express');
const router = express.Router();
const { isValidUUID, escapeLikePattern } = require('../../utils/validate');
const { logger } = require('../../utils/logger');

// GET /leads/:clientId
router.get('/leads/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const { stage, minScore, search } = req.query;
    const pageNum = Math.max(1, Math.min(10000, parseInt(req.query.page) || 1));
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    if (isNaN(pageNum) || isNaN(limitNum)) {
      return res.status(400).json({ error: 'Invalid pagination parameters' });
    }
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    const params = [clientId];

    conditions.push('client_id = ?');

    if (stage) {
      conditions.push('stage = ?');
      params.push(stage);
    }
    if (minScore) {
      const ms = parseInt(minScore);
      if (!isNaN(ms)) {
        conditions.push('score >= ?');
        params.push(ms);
      }
    }
    if (search) {
      conditions.push('(name LIKE ? OR phone LIKE ? OR email LIKE ?)');
      const escapedSearch = escapeLikePattern(search);
      const searchPattern = `%${escapedSearch}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    const where = conditions.join(' AND ');

    const countParams = [...params];
    const total = db.prepare(`SELECT COUNT(*) as count FROM leads WHERE ${where}`).get(...countParams).count;

    const queryParams = [...params, limitNum, offset];
    const leads = db.prepare(
      `SELECT * FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...queryParams);

    // Batch-load recent interactions for all leads in a single query per table
    // Build parameterized IN clause to prevent SQL injection
    let allCalls = [];
    let allMessages = [];

    if (leads.length > 0) {
      const placeholders = leads.map(() => '?').join(',');
      const callParams = [clientId, ...leads.map(l => l.phone)];
      allCalls = db.prepare(`
        SELECT id, call_id, duration, outcome, summary, score, created_at, caller_phone
        FROM calls
        WHERE client_id = ? AND caller_phone IN (${placeholders})
        ORDER BY created_at DESC LIMIT 500
      `).all(...callParams);

      const messageParams = [clientId, ...leads.map(l => l.phone)];
      allMessages = db.prepare(`
        SELECT id, direction, body, created_at, phone
        FROM messages
        WHERE client_id = ? AND phone IN (${placeholders})
        ORDER BY created_at DESC LIMIT 500
      `).all(...messageParams);
    }

    // Group results by lead phone and limit to 3 per lead
    const callsByPhone = {};
    const messagesByPhone = {};

    allCalls.forEach(call => {
      if (!callsByPhone[call.caller_phone]) callsByPhone[call.caller_phone] = [];
      if (callsByPhone[call.caller_phone].length < 3) {
        callsByPhone[call.caller_phone].push(call);
      }
    });

    allMessages.forEach(msg => {
      if (!messagesByPhone[msg.phone]) messagesByPhone[msg.phone] = [];
      if (messagesByPhone[msg.phone].length < 3) {
        messagesByPhone[msg.phone].push(msg);
      }
    });

    // Attach recent interactions to each lead
    const leadsWithInteractions = leads.map(lead => ({
      ...lead,
      recent_calls: callsByPhone[lead.phone] || [],
      recent_messages: messagesByPhone[lead.phone] || []
    }));

    const totalPages = Math.ceil(total / limitNum);
    res.json({ leads: leadsWithInteractions, total, page: pageNum, limit: limitNum, total_pages: totalPages });
  } catch (err) {
    logger.error('[api] leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// PUT /leads/:clientId/:leadId
router.put('/leads/:clientId/:leadId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    // Validate clientId and leadId format
    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return res.status(400).json({ error: 'Invalid client ID or lead ID format' });
    }

    const { stage } = req.body;

    const validStages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ error: `Invalid stage. Must be one of: ${validStages.join(', ')}` });
    }

    const result = db.prepare(
      'UPDATE leads SET stage = ?, updated_at = ? WHERE id = ? AND client_id = ?'
    ).run(stage, new Date().toISOString(), leadId, clientId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ success: true, stage });
  } catch (err) {
    logger.error('[api] update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

module.exports = router;
