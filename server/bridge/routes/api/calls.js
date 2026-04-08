const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { success, paginated } = require('../../utils/response');
const { validateQuery, validateParams } = require('../../middleware/validateRequest');
const { CallQuerySchema } = require('../../utils/schemas/calls');
const { ClientParamsSchema } = require('../../utils/schemas/client');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

const RETELL_API_KEY = process.env.RETELL_API_KEY;

// GET /calls/:clientId
router.get('/calls/:clientId', validateParams(ClientParamsSchema), validateQuery(CallQuerySchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { outcome, startDate, endDate, minScore, limit: limitNum, offset } = req.query;
    const conditions = [];
    const params = [clientId];

    // Start with clientId
    conditions.push('client_id = ?');

    // Add optional filters
    if (outcome) {
      conditions.push('outcome = ?');
      params.push(outcome);
    }
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }
    if (minScore) {
      const ms = parseInt(minScore);
      if (!isNaN(ms)) {
        conditions.push('score >= ?');
        params.push(ms);
      }
    }

    const where = conditions.join(' AND ');

    const countParams = [...params];
    const countResult = await db.query(`SELECT COUNT(*) as count FROM calls WHERE ${where}`, countParams, 'get');
    const total = countResult.count;

    const queryParams = [...params, limitNum, offset];
    const calls = await db.query(
      `SELECT id, call_id, caller_phone, direction, duration, outcome, summary, score, sentiment, created_at
       FROM calls WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      queryParams,
      'all'
    );

    return paginated(res, { data: calls, total, limit: limitNum, offset });
  } catch (err) {
    logger.error('[api] calls error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch calls', 500));
  }
});

// GET /calls/:clientId/:callId/transcript
router.get('/calls/:clientId/:callId/transcript', async (req, res, next) => {
  try {
    const { callId } = req.params;

    const retellResp = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!retellResp.ok) {
      return res.status(retellResp.status).json({ error: 'Failed to fetch transcript from Retell' });
    }

    const callData = await retellResp.json();
    return success(res, { transcript: callData.transcript || [] });
  } catch (err) {
    logger.error('[api] transcript error:', err);
    next(err);
  }
});

// GET /calls/:clientId/:callId/transcript/download — download as .txt file
router.get('/calls/:clientId/:callId/transcript/download', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId, callId } = req.params;

    // Try local DB first (faster), fallback to Retell API
    const localCall = await db.query(
      'SELECT transcript, caller_phone, created_at, summary FROM calls WHERE call_id = ? AND client_id = ?',
      [callId, clientId],
      'get'
    );

    let transcriptText = '';
    let callerPhone = localCall?.caller_phone || 'unknown';
    let callDate = localCall?.created_at || new Date().toISOString();
    let summary = localCall?.summary || '';

    if (localCall?.transcript && localCall.transcript.trim().length > 10) {
      transcriptText = localCall.transcript;
    } else {
      // Fallback: fetch from Retell
      const retellResp = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
        headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      if (retellResp.ok) {
        const callData = await retellResp.json();
        const raw = callData.transcript || '';
        transcriptText = typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.map(t => `${t.role}: ${t.content}`).join('\n')
            : JSON.stringify(raw, null, 2);
      }
    }

    if (!transcriptText) {
      return res.status(404).json({ error: 'No transcript available for this call' });
    }

    // Format as readable text file
    const header = [
      `ELYVN Call Transcript`,
      `Call ID: ${callId}`,
      `Caller: ${callerPhone}`,
      `Date: ${callDate}`,
      summary ? `Summary: ${summary}` : '',
      '\u2500'.repeat(50),
      '',
    ].filter(Boolean).join('\n');

    const fileContent = header + transcriptText;
    const filename = `transcript-${callId.substring(0, 8)}-${callDate.split('T')[0]}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fileContent);
  } catch (err) {
    logger.error('[api] transcript download error:', err);
    next(err);
  }
});

module.exports = router;
