const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getOnboardingLink } = require('../utils/telegram');
const { logger } = require('../utils/logger');
const { logDataMutation } = require('../utils/auditLog');
const { AppError } = require('../utils/AppError');

// NOTE: The 'plan' column is handled by migration 022_auth_and_billing.
// Removed rogue DB connection that opened a second database handle at module load.

/**
 * Make an HTTPS request and return {status, body, headers}
 */
function httpsRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        } catch (err) {
          // Return raw body if JSON parse fails
          resolve({ status: res.statusCode, body, headers: res.headers, parseError: err });
        }
      });
    });

    req.on('error', reject);
    if (data) {
      if (typeof data === 'string') {
        req.write(data);
      } else {
        req.write(JSON.stringify(data));
      }
    }
    req.end();
  });
}

/**
 * Create a Retell AI agent
 */
async function createRetellAgent(businessName, knowledgeBaseSummary, voiceId, language) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    throw new AppError('INTERNAL_ERROR', 'RETELL_API_KEY is required', 500);
  }

  const kbText = knowledgeBaseSummary || 'Help customers with their inquiries professionally and courteously.';
  const generalPrompt = `You are an AI receptionist for ${businessName}. ${kbText}`;

  const payload = {
    agent_name: businessName,
    voice_id: voiceId || '11labs-Adrian',
    language: language || 'en-US',
    response_engine: {
      type: 'retell-llm',
      llm_id: null,
    },
    general_prompt: generalPrompt,
  };

  const options = {
    hostname: 'api.retellai.com',
    port: 443,
    path: '/v2/create-agent',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };

  const response = await httpsRequest(options, payload);
  if (response.status !== 200 && response.status !== 201) {
    throw new AppError('INTERNAL_ERROR', `Retell creation failed (${response.status}): ${JSON.stringify(response.body || response.parseError)}`, 500);
  }

  return response.body.agent_id || response.body.id;
}

/**
 * POST / — Provision a new client with Telnyx number, Retell agent, and knowledge base
 */
router.post('/', async (req, res, next) => {
  if (!req.isAdmin) return next(new AppError('FORBIDDEN', 'Admin access required', 403));
  try {
    const db = req.app.locals.db;
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const {
      business_name,
      owner_name,
      owner_phone,
      owner_email,
      industry,
      avg_ticket,
      plan,
      timezone,
      area_code,
      knowledge_base,
    } = req.body;

    // Validate required fields
    if (!business_name) {
      return res.status(400).json({ error: 'business_name is required' });
    }
    if (!owner_phone) {
      return res.status(400).json({ error: 'owner_phone is required' });
    }
    if (!plan) {
      return res.status(400).json({ error: 'plan is required' });
    }

    const clientId = randomUUID();
    const now = new Date().toISOString();
    const provisioning_status = {
      client_id: clientId,
      retell_agent_id: null,
      retell_error: null,
      db_save: null,
      db_error: null,
      kb_save: null,
      kb_error: null,
    };

    logger.info(`[provision] Starting provisioning for ${business_name} (${clientId})`);

    // Step 1: Create Retell agent (optional, don't fail overall provisioning if this fails)
    let retellAgentId = null;
    try {
      const kbSummary = knowledge_base
        ? `You serve ${knowledge_base.business_name || business_name}. Services: ${(knowledge_base.services || []).join(', ') || 'various services'}. Business hours: ${knowledge_base.hours || 'standard hours'}. Location: ${knowledge_base.location || 'contact for details'}.`
        : null;

      logger.info(`[provision] Creating Retell agent for ${business_name}...`);
      retellAgentId = await createRetellAgent(business_name, kbSummary, req.body.retell_voice, req.body.retell_language);
      provisioning_status.retell_agent_id = retellAgentId;
      logger.info(`[provision] Successfully created Retell agent: ${retellAgentId}`);
    } catch (err) {
      provisioning_status.retell_error = err.message;
      logger.error(`[provision] Retell provisioning failed: ${err.message}`);
      // Don't return — allow client creation without Retell
    }

    // Step 2: Save client to database
    try {
      const twilioPhone = process.env.TWILIO_PHONE_NUMBER || null;
      await db.query(`
        INSERT INTO clients (
          id, business_name, owner_name, owner_phone, owner_email,
          retell_agent_id, twilio_phone, phone_number, industry, timezone,
          avg_ticket, plan, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        clientId,
        business_name,
        owner_name || null,
        owner_phone,
        owner_email || null,
        retellAgentId || null,
        twilioPhone,
        twilioPhone,
        industry || null,
        timezone || 'UTC',
        avg_ticket || 0,
        plan || 'pro',
        now,
        now
      ], 'run');

      provisioning_status.db_save = true;
      logger.info(`[provision] Successfully saved client to database: ${clientId}`);
      try { logDataMutation(db, { action: 'client_created', table: 'clients', recordId: clientId, newValues: { business_name, owner_phone, plan, industry }, ip: req.ip }); } catch (_) {}
    } catch (err) {
      provisioning_status.db_error = err.message;
      logger.error(`[provision] Database save failed: ${err.message}`);
      return res.status(500).json({
        error: 'Failed to save client to database',
        message: process.env.NODE_ENV !== 'production' ? err.message : undefined,
        provisioning_status,
      });
    }

    // Step 3: Save knowledge base JSON
    if (knowledge_base) {
      try {
        const kbDir = path.join(__dirname, '../../mcp/knowledge_bases');
        await fs.promises.mkdir(kbDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(kbDir, `${clientId}.json`),
          JSON.stringify(knowledge_base, null, 2)
        );
        provisioning_status.kb_save = true;
        logger.info(`[provision] Successfully saved knowledge base: ${clientId}.json`);
      } catch (err) {
        provisioning_status.kb_error = err.message;
        logger.error(`[provision] Knowledge base save failed: ${err.message}`);
        // Don't fail the entire provisioning for KB save failures
      }
    }

    // Retrieve the full client record
    const client = await db.query('SELECT id, business_name, owner_name, owner_email, owner_phone, industry, timezone, plan, retell_agent_id, retell_phone, twilio_phone, phone_number, is_active, created_at FROM clients WHERE id = ?', [clientId], 'get');

    // Generate Telegram onboarding link
    const telegram_link = getOnboardingLink(clientId);
    provisioning_status.telegram_link = telegram_link;

    logger.info(`[provision] Provisioning complete for ${business_name} (${clientId})`);
    logger.info(`[provision] Telegram link: ${telegram_link}`);

    return res.status(201).json({
      client,
      provisioning_status,
      telegram_link,
      success: provisioning_status.db_save === true,
    });
  } catch (err) {
    logger.error('[provision] Unexpected error:', err);
    return res.status(500).json({
      error: 'Unexpected error during provisioning',
      message: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
