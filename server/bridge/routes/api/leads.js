const express = require('express');
const router = express.Router();
const { isValidUUID, escapeLikePattern } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { appendEvent, Events } = require('../../utils/eventStore');
const { buildLeadTimeline } = require('../../utils/eventProjections');
const { getClientLeadPriorities } = require('../../utils/leadIntelligence');
const { decrypt } = require('../../utils/encryption');
const { logDataMutation } = require('../../utils/auditLog');
const { validateQuery, validateBody, validateParams } = require('../../middleware/validateRequest');
const { LeadQuerySchema, LeadUpdateSchema } = require('../../utils/schemas/lead');
const { ClientParamsSchema } = require('../../utils/schemas/client');
const { success, paginated } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /leads/:clientId — migrated to async db.query() for SQLite + Supabase compatibility
router.get('/leads/:clientId', validateParams(ClientParamsSchema), validateQuery(LeadQuerySchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { stage, minScore, search, limit: limitNum, offset } = req.query;
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

    const countResult = await db.query(`SELECT COUNT(*) as count FROM leads WHERE ${where}`, params, 'get');
    const total = countResult.count;

    const queryParams = [...params, limitNum, offset];
    const leads = await db.query(
      `SELECT * FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      queryParams, 'all'
    );

    // Gradual encryption migration: prefer decrypted encrypted columns, fall back to plaintext
    for (const lead of leads) {
      if (lead.phone_encrypted) {
        try {
          const decrypted = decrypt(lead.phone_encrypted);
          if (decrypted && decrypted !== lead.phone_encrypted) lead.phone = decrypted;
        } catch (_) { /* fall back to plaintext phone */ }
      }
      if (lead.email_encrypted) {
        try {
          const decrypted = decrypt(lead.email_encrypted);
          if (decrypted && decrypted !== lead.email_encrypted) lead.email = decrypted;
        } catch (_) { /* fall back to plaintext email */ }
      }
    }

    // Batch-load recent interactions for all leads in a single query per table
    // Build parameterized IN clause to prevent SQL injection
    let allCalls = [];
    let allMessages = [];

    if (leads.length > 0) {
      const placeholders = leads.map(() => '?').join(',');
      const callParams = [clientId, ...leads.map(l => l.phone)];
      allCalls = await db.query(`
        SELECT id, call_id, duration, outcome, summary, score, created_at, caller_phone
        FROM calls
        WHERE client_id = ? AND caller_phone IN (${placeholders})
        ORDER BY created_at DESC LIMIT 500
      `, callParams, 'all');

      const messageParams = [clientId, ...leads.map(l => l.phone)];
      allMessages = await db.query(`
        SELECT id, direction, body, created_at, phone
        FROM messages
        WHERE client_id = ? AND phone IN (${placeholders})
        ORDER BY created_at DESC LIMIT 500
      `, messageParams, 'all');
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

    return paginated(res, { data: leadsWithInteractions, total, limit: limitNum, offset });
  } catch (err) {
    logger.error('[api] leads error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch leads', 500));
  }
});

// PUT /leads/:clientId/:leadId — migrated to async db.query() for SQLite + Supabase compatibility
router.put('/leads/:clientId/:leadId', validateBody(LeadUpdateSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    // Validate clientId and leadId format
    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID or lead ID format', 400));
    }

    const { stage, revenue_closed, job_value } = req.body;

    // Stage validation is handled by Zod schema (LeadUpdateSchema). No redundant check needed.
    if (revenue_closed !== undefined && (typeof revenue_closed !== 'number' || revenue_closed < 0)) {
      return next(new AppError('VALIDATION_ERROR', 'revenue_closed must be a non-negative number', 400));
    }
    if (job_value !== undefined && (typeof job_value !== 'number' || job_value < 0)) {
      return next(new AppError('VALIDATION_ERROR', 'job_value must be a non-negative number', 400));
    }
    if (!stage && revenue_closed === undefined && job_value === undefined) {
      return next(new AppError('VALIDATION_ERROR', 'At least one of stage, revenue_closed, or job_value is required', 400));
    }

    // Capture old stage before update for event emission
    const existingLead = await db.query('SELECT stage, revenue_closed FROM leads WHERE id = ? AND client_id = ?', [leadId, clientId], 'get');
    const oldStage = existingLead?.stage;

    // Build dynamic update
    const updates = [];
    const updateParams = [];
    if (stage) { updates.push('stage = ?'); updateParams.push(stage); }
    if (revenue_closed !== undefined) { updates.push('revenue_closed = ?'); updateParams.push(revenue_closed); }
    if (job_value !== undefined) { updates.push('job_value = ?'); updateParams.push(job_value); }
    updates.push('updated_at = ?');
    updateParams.push(new Date().toISOString());
    updateParams.push(leadId, clientId);

    const result = await db.query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = ? AND client_id = ?`,
      updateParams, 'run'
    );

    if (result.changes === 0) {
      return next(new AppError('NOT_FOUND', 'Lead not found', 404));
    }

    // Fire-and-forget: emit LeadStageChanged if stage actually changed
    if (stage && oldStage && oldStage !== stage) {
      try { appendEvent(db, leadId, 'lead', Events.LeadStageChanged, { from: oldStage, to: stage, trigger: 'api' }, clientId); } catch (_) {}

      // Outbound webhook: notify client's configured stage_change_webhook_url
      try {
        const { fireLeadStageChanged } = require('../../utils/webhookEvents');
        const client = await db.query('SELECT id, stage_change_webhook_url FROM clients WHERE id = ?', [clientId], 'get');
        if (client) {
          const lead = await db.query('SELECT name, phone, email, score FROM leads WHERE id = ?', [leadId], 'get');
          await fireLeadStageChanged(client, { leadId, oldStage, newStage: stage, leadData: lead || {} });
        }
      } catch (_whErr) { /* webhook fire must not break request */ }
    }

    // Fire-and-forget: audit trail for lead mutation
    const newValues = {};
    if (stage) newValues.stage = stage;
    if (revenue_closed !== undefined) newValues.revenue_closed = revenue_closed;
    if (job_value !== undefined) newValues.job_value = job_value;
    try {
      logDataMutation(db, {
        action: 'lead_updated',
        table: 'leads',
        recordId: leadId,
        clientId,
        oldValues: { stage: oldStage },
        newValues,
        ip: req.ip,
      });
    } catch (_) {}

    return success(res, { stage: stage || oldStage, revenue_closed, job_value });
  } catch (err) {
    logger.error('[api] update lead error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to update lead', 500));
  }
});

// GET /leads/:clientId/priorities — Top 10 leads ranked by feature-derived priority
router.get('/leads/:clientId/priorities', validateParams(ClientParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const priorities = await getClientLeadPriorities(db, clientId);
    return success(res, priorities);
  } catch (err) {
    logger.error('[api] lead priorities error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get lead priorities', 500));
  }
});

// GET /leads/:clientId/:leadId/timeline — Chronological event history for a lead
router.get('/leads/:clientId/:leadId/timeline', validateParams(ClientParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID or lead ID format', 400));
    }

    const timeline = await buildLeadTimeline(db, leadId, clientId);
    return success(res, timeline);
  } catch (err) {
    logger.error('[api] lead timeline error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to build lead timeline', 500));
  }
});

module.exports = router;
