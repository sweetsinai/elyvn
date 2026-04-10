const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { decrypt } = require('../../utils/encryption');
const { parsePagination } = require('../../utils/dbHelpers');
const { sendSMS } = require('../../utils/sms');
const { broadcast } = require('../../utils/websocket');
const { fireSmsSent } = require('../../utils/webhookEvents');
const { validateQuery, validateParams, validateBody } = require('../../middleware/validateRequest');
const { success, paginated, created } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
const {
  ConversationParamsSchema,
  ConversationDetailParamsSchema,
  ConversationQuerySchema,
  ConversationTimelineQuerySchema,
  SendMessageBodySchema,
} = require('../../utils/schemas/conversation');

router.param('clientId', clientIsolationParam);

// ---------------------------------------------------------------------------
// GET /conversations/:clientId — list conversations (inbox view)
// ---------------------------------------------------------------------------
router.get('/conversations/:clientId',
  validateParams(ConversationParamsSchema),
  validateQuery(ConversationQuerySchema),
  async (req, res, next) => {
    try {
      const db = req.app.locals.db;
      const { clientId } = req.params;
      const { status, search } = req.query;
      const { limit, offset } = parsePagination(req.query, 30, 100);

      const conditions = ['c.client_id = ?'];
      const params = [clientId];

      if (status && status !== 'all') {
        conditions.push('c.status = ?');
        params.push(status);
      }

      if (search) {
        conditions.push('(c.lead_phone LIKE ? OR c.lead_name LIKE ? OR c.last_message_preview LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like);
      }

      const where = conditions.join(' AND ');

      const countResult = await db.query(
        `SELECT COUNT(*) as count FROM conversations c WHERE ${where}`, params, 'get'
      );
      const total = countResult.count;

      const conversations = await db.query(`
        SELECT c.*, l.score as lead_score, l.stage as lead_stage
        FROM conversations c
        LEFT JOIN leads l ON l.id = c.lead_id
        WHERE ${where}
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT ? OFFSET ?
      `, [...params, limit, offset], 'all');

      return paginated(res, { data: conversations, total, limit, offset });
    } catch (err) {
      logger.error('[api] conversations list error:', err);
      return next(new AppError('INTERNAL_ERROR', 'Failed to fetch conversations', 500));
    }
  }
);

// ---------------------------------------------------------------------------
// GET /conversations/:clientId/:conversationId/timeline — unified timeline
// ---------------------------------------------------------------------------
router.get('/conversations/:clientId/:conversationId/timeline',
  validateParams(ConversationDetailParamsSchema),
  validateQuery(ConversationTimelineQuerySchema),
  async (req, res, next) => {
    try {
      const db = req.app.locals.db;
      const { clientId, conversationId } = req.params;
      const { include_calls } = req.query;
      const { limit, offset } = parsePagination(req.query, 50, 200);

      // Verify conversation exists and belongs to client
      const conversation = await db.query(
        'SELECT * FROM conversations WHERE id = ? AND client_id = ?',
        [conversationId, clientId], 'get'
      );
      if (!conversation) {
        return next(new AppError('NOT_FOUND', 'Conversation not found', 404));
      }

      // Get messages for this conversation
      const messages = await db.query(`
        SELECT id, direction, body, status, channel, delivery_status, delivered_at,
               read_at, confidence, reply_text, created_at, message_sid,
               'message' as entry_type
        FROM messages
        WHERE conversation_id = ? AND client_id = ?
        ORDER BY created_at ASC
      `, [conversationId, clientId], 'all');

      // Decrypt body if encrypted
      for (const msg of messages) {
        if (msg.body_encrypted) {
          try {
            const decrypted = decrypt(msg.body_encrypted);
            if (decrypted && decrypted !== msg.body_encrypted) msg.body = decrypted;
          } catch (_) { /* fall back */ }
        }
      }

      let timeline = messages;

      // Merge calls if requested
      if (include_calls) {
        const calls = await db.query(`
          SELECT id, call_id, direction, duration, summary, sentiment, score,
                 outcome, caller_phone, created_at, recording_url,
                 'call' as entry_type
          FROM calls
          WHERE client_id = ? AND caller_phone = ?
          ORDER BY created_at ASC
        `, [clientId, conversation.lead_phone], 'all');

        timeline = [...messages, ...calls].sort(
          (a, b) => new Date(a.created_at) - new Date(b.created_at)
        );
      }

      // Apply pagination to merged timeline
      const total = timeline.length;
      const paged = timeline.slice(offset, offset + limit);

      return paginated(res, { data: paged, total, limit, offset });
    } catch (err) {
      logger.error('[api] conversation timeline error:', err);
      return next(new AppError('INTERNAL_ERROR', 'Failed to fetch timeline', 500));
    }
  }
);

// ---------------------------------------------------------------------------
// POST /conversations/:clientId/:conversationId/send — two-way SMS
// ---------------------------------------------------------------------------
router.post('/conversations/:clientId/:conversationId/send',
  validateParams(ConversationDetailParamsSchema),
  validateBody(SendMessageBodySchema),
  async (req, res, next) => {
    try {
      const db = req.app.locals.db;
      const { clientId, conversationId } = req.params;
      const { body } = req.body;

      // Load conversation
      const conversation = await db.query(
        'SELECT * FROM conversations WHERE id = ? AND client_id = ?',
        [conversationId, clientId], 'get'
      );
      if (!conversation) {
        return next(new AppError('NOT_FOUND', 'Conversation not found', 404));
      }

      // Load client for from number
      const client = await db.query(
        'SELECT id, phone_number, sms_webhook_url FROM clients WHERE id = ?',
        [clientId], 'get'
      );
      if (!client?.phone_number) {
        return next(new AppError('CONFIG_ERROR', 'No phone number configured for this client', 400));
      }

      // Send SMS
      const result = await sendSMS(conversation.lead_phone, body, client.phone_number, db, clientId);
      if (!result.success) {
        return next(new AppError('SMS_FAILED', result.error || result.reason || 'SMS send failed', 400));
      }

      // Record message
      const msgId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.query(`
        INSERT INTO messages (id, client_id, phone, direction, body, status, channel,
                              conversation_id, delivery_status, message_sid, lead_id, created_at, updated_at)
        VALUES (?, ?, ?, 'outbound', ?, 'manual_reply', 'sms', ?, 'sent', ?, ?, ?, ?)
      `, [msgId, clientId, conversation.lead_phone, body, conversationId,
          result.messageId || null, conversation.lead_id, now, now], 'run');

      // Update conversation
      const preview = body.substring(0, 100);
      await db.query(`
        UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ?
        WHERE id = ?
      `, [now, preview, now, conversationId], 'run');

      // WebSocket broadcast
      broadcast('new_message', {
        id: msgId,
        conversationId,
        phone: conversation.lead_phone,
        direction: 'outbound',
        body,
        status: 'manual_reply',
        delivery_status: 'sent',
        lead_id: conversation.lead_id,
      }, clientId);

      // Fire webhook
      if (client.sms_webhook_url) {
        fireSmsSent(client, {
          to: conversation.lead_phone,
          from: client.phone_number,
          body,
          messageId: result.messageId,
          leadId: conversation.lead_id,
        });
      }

      return created(res, {
        id: msgId,
        conversationId,
        messageId: result.messageId,
        delivery_status: 'sent',
      });
    } catch (err) {
      logger.error('[api] conversation send error:', err);
      return next(new AppError('INTERNAL_ERROR', 'Failed to send message', 500));
    }
  }
);

// ---------------------------------------------------------------------------
// PUT /conversations/:clientId/:conversationId/read — mark as read
// ---------------------------------------------------------------------------
router.put('/conversations/:clientId/:conversationId/read',
  validateParams(ConversationDetailParamsSchema),
  async (req, res, next) => {
    try {
      const db = req.app.locals.db;
      const { clientId, conversationId } = req.params;
      const now = new Date().toISOString();

      // Verify conversation exists
      const conversation = await db.query(
        'SELECT id FROM conversations WHERE id = ? AND client_id = ?',
        [conversationId, clientId], 'get'
      );
      if (!conversation) {
        return next(new AppError('NOT_FOUND', 'Conversation not found', 404));
      }

      // Mark inbound messages as read
      await db.query(`
        UPDATE messages SET read_at = ?, delivery_status = 'read', updated_at = ?
        WHERE conversation_id = ? AND direction = 'inbound' AND read_at IS NULL
      `, [now, now, conversationId], 'run');

      // Reset unread count
      await db.query(
        'UPDATE conversations SET unread_count = 0, updated_at = ? WHERE id = ?',
        [now, conversationId], 'run'
      );

      return success(res, { conversationId, read_at: now });
    } catch (err) {
      logger.error('[api] conversation read error:', err);
      return next(new AppError('INTERNAL_ERROR', 'Failed to mark as read', 500));
    }
  }
);

// ---------------------------------------------------------------------------
// PUT /conversations/:clientId/:conversationId/archive — archive conversation
// ---------------------------------------------------------------------------
router.put('/conversations/:clientId/:conversationId/archive',
  validateParams(ConversationDetailParamsSchema),
  async (req, res, next) => {
    try {
      const db = req.app.locals.db;
      const { clientId, conversationId } = req.params;
      const now = new Date().toISOString();

      const result = await db.query(
        "UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ? AND client_id = ?",
        [now, conversationId, clientId], 'run'
      );

      return success(res, { conversationId, status: 'archived' });
    } catch (err) {
      logger.error('[api] conversation archive error:', err);
      return next(new AppError('INTERNAL_ERROR', 'Failed to archive conversation', 500));
    }
  }
);

module.exports = router;
