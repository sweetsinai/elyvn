const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { isValidUUID } = require('../../utils/validate');
const config = require('../../utils/config');
const { withTimeout } = require('../../utils/resilience');
const { logger } = require('../../utils/logger');
const { LENGTH_LIMITS } = require('../../utils/inputValidation');

const anthropic = new Anthropic();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANTHROPIC_TIMEOUT = 30000;

// POST /chat — Anthropic API proxy for dashboard AI features
router.post('/chat', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { messages, clientId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Validate messages array — check each message has required fields and reasonable sizes
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.role || !msg.content) {
        return res.status(400).json({ error: `Message at index ${i} missing role or content` });
      }
      if (typeof msg.role !== 'string' || !['user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: `Message at index ${i} has invalid role` });
      }
      if (typeof msg.content !== 'string') {
        return res.status(400).json({ error: `Message at index ${i} content must be a string` });
      }
      if (msg.content.length > LENGTH_LIMITS.text) {
        return res.status(400).json({ error: `Message at index ${i} exceeds maximum length of ${LENGTH_LIMITS.text} characters` });
      }
    }

    // Load client KB as system context
    let systemPrompt = 'You are an AI assistant for the ELYVN operations dashboard.';

    if (clientId && UUID_RE.test(clientId)) {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
      if (client) {
        systemPrompt += `\n\nYou are assisting with ${client.business_name}.`;
      }

      if (isValidUUID(clientId)) {
        const kbPath = path.join(__dirname, '../../../mcp/knowledge_bases', `${clientId}.json`);
        try {
          // Verify path doesn't escape knowledge_bases directory
          const resolvedPath = path.resolve(kbPath);
          const kbDir = path.resolve(path.join(__dirname, '../../../mcp/knowledge_bases'));
          if (!resolvedPath.startsWith(kbDir)) {
            logger.error('[api] KB path traversal attempted');
          } else {
            const kbData = await fs.promises.readFile(kbPath, 'utf8');
            systemPrompt += `\n\nBusiness Knowledge Base:\n${kbData}`;
          }
        } catch (err) {
          logger.error('[api] Failed to load knowledge base:', err.message);
        }
      }

      // Add recent stats context
      try {
        const callCount = db.prepare('SELECT COUNT(*) as count FROM calls WHERE client_id = ?').get(clientId).count;
        const leadCount = db.prepare('SELECT COUNT(*) as count FROM leads WHERE client_id = ?').get(clientId).count;
        systemPrompt += `\n\nCurrent stats: ${callCount} total calls, ${leadCount} total leads.`;
      } catch (err) {
        logger.error('[api] Failed to load stats:', err.message);
      }
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
    res.status(500).json({ error: 'Failed to process chat' });
  }
});

module.exports = router;
