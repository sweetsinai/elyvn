const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { isValidUUID } = require('../../utils/validate');
const { getKBRoot } = require('../../utils/dbConfig');
const config = require('../../utils/config');
const { withTimeout } = require('../../utils/resilience');
const { logger } = require('../../utils/logger');
const { LENGTH_LIMITS } = require('../../utils/inputValidation');
const { emailSendLimit } = require('../../middleware/rateLimits');
const { AppError } = require('../../utils/AppError');
const { validateBody } = require('../../middleware/validateRequest');
const { ChatSchema } = require('../../utils/schemas/chat');

const { ANTHROPIC_TIMEOUT } = require('../../config/timing');
const anthropic = new Anthropic();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sanitize = (s, max) => String(s || '').replace(/[\r\n\t<>{}]/g, ' ').substring(0, max);

// POST /chat — Anthropic API proxy for dashboard AI features — 20/min per client
router.post('/chat', emailSendLimit, validateBody(ChatSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    let { messages, clientId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return next(new AppError('VALIDATION_ERROR', 'messages array is required', 422));
    }

    // Validate messages array — check each message has required fields and reasonable sizes
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.role || !msg.content) {
        return next(new AppError('VALIDATION_ERROR', `Message at index ${i} missing role or content`, 422));
      }
      if (typeof msg.role !== 'string' || !['user', 'assistant'].includes(msg.role)) {
        return next(new AppError('VALIDATION_ERROR', `Message at index ${i} has invalid role`, 422));
      }
      if (typeof msg.content !== 'string') {
        return next(new AppError('VALIDATION_ERROR', `Message at index ${i} content must be a string`, 422));
      }
      if (msg.content.length > LENGTH_LIMITS.text) {
        return next(new AppError('VALIDATION_ERROR', `Message at index ${i} exceeds maximum length of ${LENGTH_LIMITS.text} characters`, 422));
      }
    }

    // Load client KB as system context — use auth-derived clientId, not body-supplied one
    // req.clientId comes from JWT/API-key middleware; req.isAdmin may override
    const resolvedClientId = req.isAdmin
      ? (clientId && UUID_RE.test(clientId) ? clientId : req.clientId)
      : req.clientId;

    let systemPrompt = 'You are an AI assistant for the ELYVN operations dashboard.';

    if (resolvedClientId && UUID_RE.test(resolvedClientId)) {
      const clientId = resolvedClientId; // shadow body var so rest of block uses auth value
      const client = await db.query('SELECT id, business_name FROM clients WHERE id = ?', [clientId], 'get');
      if (client) {
        systemPrompt += `\n\nYou are assisting with ${sanitize(client.business_name, 200)}.`;
      }

      if (isValidUUID(clientId)) {
        const kbDir = getKBRoot();
        const kbPath = path.join(kbDir, `${clientId}.json`);
        try {
          // Verify path doesn't escape knowledge_bases directory
          const resolvedPath = path.resolve(kbPath);
          const resolvedKbDir = path.resolve(kbDir);
          if (!resolvedPath.startsWith(resolvedKbDir)) {
            logger.error('[api] KB path traversal attempted');
          } else {
            const kbData = await fs.promises.readFile(kbPath, 'utf8');
            systemPrompt += `\n\nBusiness Knowledge Base:\n${sanitize(kbData, 4000)}`;
          }
        } catch (err) {
          logger.error('[api] Failed to load knowledge base:', err.message);
        }
      }

      // Add recent stats context
      try {
        const callCountResult = await db.query('SELECT COUNT(*) as count FROM calls WHERE client_id = ?', [clientId], 'get');
        const callCount = callCountResult.count;
        const leadCountResult = await db.query('SELECT COUNT(*) as count FROM leads WHERE client_id = ?', [clientId], 'get');
        const leadCount = leadCountResult.count;
        systemPrompt += `\n\nCurrent stats: ${callCount} total calls, ${leadCount} total leads.`;
      } catch (err) {
        logger.error('[api] Failed to load stats:', err.message);
      }
    }

    // Token estimation — trim history to prevent context overflow
    const estimatedTokens = messages.reduce((acc, m) => acc + (String(m.content || '').length / 4), 0);
    if (estimatedTokens > 8000) {
      // Keep only last 20 messages to prevent context overflow
      messages = messages.slice(-20);
    }

    // Stream response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await withTimeout(
      (signal) => anthropic.messages.stream({
        model: config.ai.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages
      }),
      ANTHROPIC_TIMEOUT,
      'Anthropic streaming chat'
    );

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    stream.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      logger.error('[api] chat stream error:', err);
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    logger.error('[api] chat error:', err);
    next(err);
  }
});

module.exports = router;
