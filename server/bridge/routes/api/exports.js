/**
 * CRM Export Endpoints
 * Export leads, calls, and messages as CSV or JSON for CRM integration.
 */
const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { logDataMutation } = require('../../utils/auditLog');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /exports/:clientId/leads — Export leads as CSV or JSON
router.get('/exports/:clientId/leads', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const format = (req.query.format || 'csv').toLowerCase();

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const maxRows = Math.min(parseInt(req.query.limit) || 50000, 50000);
    const leads = await db.query(
      `SELECT id, name, phone, email, source, score, stage, revenue_closed, job_value, created_at, updated_at
       FROM leads WHERE client_id = ? ORDER BY updated_at DESC LIMIT ?`,
      [clientId, maxRows], 'all'
    );

    // Audit log the export event
    try { logDataMutation(req.app.locals.db, { action: 'data_export', table: 'leads', recordId: clientId, newValues: { format, count: leads.length }, ip: req.ip }); } catch (_) {}

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="leads-${clientId.slice(0, 8)}.json"`);
      return res.json({ data: leads, exported_at: new Date().toISOString(), count: leads.length });
    }

    // CSV format
    const headers = 'id,name,phone,email,source,score,stage,revenue_closed,job_value,created_at,updated_at';
    const escCsv = (v) => {
      let s = String(v ?? '');
      // CSV formula injection protection — prefix dangerous starting chars with tab
      if (/^[=+\-@\t\r]/.test(s)) s = '\t' + s;
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = leads.map(l =>
      [l.id, l.name, l.phone, l.email, l.source, l.score, l.stage, l.revenue_closed, l.job_value, l.created_at, l.updated_at]
        .map(escCsv).join(',')
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${clientId.slice(0, 8)}.csv"`);
    res.send([headers, ...rows].join('\n'));
  } catch (err) {
    logger.error('[exports] leads export error:', err);
    next(err);
  }
});

// GET /exports/:clientId/calls — Export calls as CSV or JSON
router.get('/exports/:clientId/calls', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const format = (req.query.format || 'csv').toLowerCase();
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const maxRows = Math.min(parseInt(req.query.limit) || 50000, 50000);
    const calls = await db.query(
      `SELECT id, call_id, caller_phone, direction, duration, outcome, score, sentiment, summary, created_at
       FROM calls WHERE client_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      [clientId, since, maxRows], 'all'
    );

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="calls-${clientId.slice(0, 8)}.json"`);
      return res.json({ data: calls, exported_at: new Date().toISOString(), count: calls.length });
    }

    const headers = 'id,call_id,caller_phone,direction,duration,outcome,score,sentiment,summary,created_at';
    const escCsv = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = '\t' + s;
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = calls.map(c =>
      [c.id, c.call_id, c.caller_phone, c.direction, c.duration, c.outcome, c.score, c.sentiment, c.summary, c.created_at]
        .map(escCsv).join(',')
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="calls-${clientId.slice(0, 8)}.csv"`);
    res.send([headers, ...rows].join('\n'));
  } catch (err) {
    logger.error('[exports] calls export error:', err);
    next(err);
  }
});

// GET /exports/:clientId/sheets — Combined export (leads + calls + messages) for Google Sheets / Zapier
router.get('/exports/:clientId/sheets', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const format = (req.query.format || 'csv').toLowerCase();
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const maxRows = Math.min(parseInt(req.query.limit) || 10000, 50000);

    const [leads, calls, messages] = await Promise.all([
      db.query(
        `SELECT id, name, phone, email, source, score, stage, revenue_closed, job_value, created_at, updated_at
         FROM leads WHERE client_id = ? ORDER BY updated_at DESC LIMIT ?`,
        [clientId, maxRows], 'all'
      ),
      db.query(
        `SELECT id, call_id, caller_phone, direction, duration, outcome, score, sentiment, summary, created_at
         FROM calls WHERE client_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
        [clientId, since, maxRows], 'all'
      ),
      db.query(
        `SELECT id, phone, channel, direction, body, status, confidence, created_at
         FROM messages WHERE client_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
        [clientId, since, maxRows], 'all'
      ),
    ]);

    try { logDataMutation(req.app.locals.db, { action: 'sheets_export', table: 'multi', recordId: clientId, newValues: { format, leads: leads.length, calls: calls.length, messages: messages.length }, ip: req.ip }); } catch (_) {}

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="sheets-${clientId.slice(0, 8)}.json"`);
      return res.json({
        leads: { data: leads, count: leads.length },
        calls: { data: calls, count: calls.length },
        messages: { data: messages, count: messages.length },
        exported_at: new Date().toISOString(),
      });
    }

    // CSV format — sections separated by blank lines
    const escCsv = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = '\t' + s;
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const sections = [];

    // Leads section
    sections.push('# Leads');
    sections.push('id,name,phone,email,source,score,stage,revenue_closed,job_value,created_at,updated_at');
    for (const l of leads) {
      sections.push([l.id, l.name, l.phone, l.email, l.source, l.score, l.stage, l.revenue_closed, l.job_value, l.created_at, l.updated_at].map(escCsv).join(','));
    }

    sections.push('');

    // Calls section
    sections.push('# Calls');
    sections.push('id,call_id,caller_phone,direction,duration,outcome,score,sentiment,summary,created_at');
    for (const c of calls) {
      sections.push([c.id, c.call_id, c.caller_phone, c.direction, c.duration, c.outcome, c.score, c.sentiment, c.summary, c.created_at].map(escCsv).join(','));
    }

    sections.push('');

    // Messages section
    sections.push('# Messages');
    sections.push('id,phone,channel,direction,body,status,confidence,created_at');
    for (const m of messages) {
      sections.push([m.id, m.phone, m.channel, m.direction, m.body, m.status, m.confidence, m.created_at].map(escCsv).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sheets-${clientId.slice(0, 8)}.csv"`);
    res.send(sections.join('\n'));
  } catch (err) {
    logger.error('[exports] sheets export error:', err);
    next(err);
  }
});

module.exports = router;
