/**
 * Integrations API — webhook delivery log + test endpoints
 */
const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /integrations/:clientId/webhook-log — recent webhook deliveries
router.get('/integrations/:clientId/webhook-log', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const fs = require('fs');
    const path = require('path');
    const QUEUE_PATH = path.resolve(__dirname, '../../data/webhook-queue.json');

    let entries = [];
    try {
      if (fs.existsSync(QUEUE_PATH)) {
        const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
        entries = JSON.parse(raw);
        if (!Array.isArray(entries)) entries = [];
      }
    } catch (_) {
      entries = [];
    }

    // Filter to entries for this client (via X-Client-Id header or payload.clientId)
    const clientEntries = entries.filter(e => {
      const headerMatch = e.headers?.['X-Client-Id'] === clientId;
      const payloadMatch = e.payload?.clientId === clientId;
      return headerMatch || payloadMatch;
    });

    // Return most recent first, limited to 50
    const sorted = clientEntries
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50)
      .map(e => ({
        id: e.id,
        url: e.url,
        event: e.payload?.event || 'unknown',
        attempts: e.attempts,
        retryAfter: e.retryAfter,
        createdAt: e.createdAt,
        lastError: e.lastError,
        status: e.attempts >= 5 ? 'failed' : 'pending',
      }));

    return success(res, { log: sorted, total: clientEntries.length });
  } catch (err) {
    logger.error('[integrations] webhook-log error:', err);
    next(err);
  }
});

// POST /integrations/:clientId/webhook-test — send a test webhook to a configured URL
router.post('/integrations/:clientId/webhook-test', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { event_type } = req.body || {};
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const WEBHOOK_FIELDS = {
      'call_ended': 'call_webhook_url',
      'lead.created': 'lead_webhook_url',
      'lead.stage_changed': 'stage_change_webhook_url',
      'sms.received': 'sms_webhook_url',
      'sms.sent': 'sms_webhook_url',
      'booking.created': 'booking_webhook_url',
    };

    const field = WEBHOOK_FIELDS[event_type];
    if (!field) {
      return next(new AppError('VALIDATION_ERROR', `Invalid event_type. Use one of: ${Object.keys(WEBHOOK_FIELDS).join(', ')}`, 422));
    }

    const client = await db.query(`SELECT id, ${field} FROM clients WHERE id = ?`, [clientId], 'get');
    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    const url = client[field];
    if (!url) {
      return next(new AppError('VALIDATION_ERROR', `No ${field} configured for this client. Set it in Settings first.`, 422));
    }

    const { enqueue } = require('../../utils/webhookQueue');
    const { buildPayload } = require('../../utils/webhookEvents');

    const testPayload = buildPayload(event_type, clientId, {
      _test: true,
      message: `Test ${event_type} webhook from ELYVN`,
      timestamp: new Date().toISOString(),
    });

    const entryId = await enqueue(url, testPayload, { 'X-Client-Id': clientId });

    return success(res, { sent: true, entryId, url, event_type });
  } catch (err) {
    logger.error('[integrations] webhook-test error:', err);
    next(err);
  }
});

// GET /integrations/:clientId/status — aggregated integration status
router.get('/integrations/:clientId/status', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const client = await db.query(`
      SELECT phone_number, retell_agent_id, transfer_phone,
             calcom_booking_link, telegram_chat_id,
             lead_webhook_url, booking_webhook_url, call_webhook_url,
             sms_webhook_url, stage_change_webhook_url
      FROM clients WHERE id = ?
    `, [clientId], 'get');

    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    const integrations = {
      retell: {
        configured: !!process.env.RETELL_API_KEY && !!client.retell_agent_id,
        details: { agent_id: !!client.retell_agent_id, api_key: !!process.env.RETELL_API_KEY },
      },
      twilio: {
        configured: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN,
        details: { phone_number: client.phone_number || null },
      },
      calcom: {
        configured: !!process.env.CALCOM_API_KEY && !!client.calcom_booking_link,
        details: { booking_link: !!client.calcom_booking_link },
      },
      telegram: {
        configured: !!process.env.TELEGRAM_BOT_TOKEN && !!client.telegram_chat_id,
        details: { chat_id: !!client.telegram_chat_id },
      },
      smtp: {
        configured: !!process.env.SMTP_HOST || !!process.env.IMAP_USER,
        details: {},
      },
      webhooks: {
        lead: !!client.lead_webhook_url,
        booking: !!client.booking_webhook_url,
        call: !!client.call_webhook_url,
        sms: !!client.sms_webhook_url,
        stage_change: !!client.stage_change_webhook_url,
      },
      transfer: {
        configured: !!client.transfer_phone,
        phone: client.transfer_phone || null,
      },
    };

    return success(res, integrations);
  } catch (err) {
    logger.error('[integrations] status error:', err);
    next(err);
  }
});

module.exports = router;
