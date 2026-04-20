const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { broadcast } = require('../utils/websocket');
const { getOnboardingLink } = require('../utils/telegram');
const { logger } = require('../utils/logger');
const { logDataMutation } = require('../utils/auditLog');
const { AppError } = require('../utils/AppError');
const { validateBody } = require('../middleware/validateRequest');
const { ProvisionSchema } = require('../utils/schemas/provision');
const { generateRetellPrompt } = require('../utils/retellSync');

// NOTE: The 'plan' column is handled by migration 022_auth_and_billing.
// Removed rogue DB connection that opened a second database handle at module load.

const { PROVISIONING_TIMEOUT_MS } = require('../config/timing');

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
  
    // Add timeout to avoid hanging on network issues
    req.setTimeout(PROVISIONING_TIMEOUT_MS || 30000, () => {
      req.destroy();
      reject(new Error(`Retell API request timed out (${(PROVISIONING_TIMEOUT_MS || 30000) / 1000}s)`));
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
 * Create a Retell LLM, then create an agent using that LLM ID
 */
async function createRetellAgent(businessName, kb, voiceId, language) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    throw new AppError('INTERNAL_ERROR', 'RETELL_API_KEY is required', 500);
  }

  const generalPrompt = generateRetellPrompt(kb || { business_name: businessName });

  // Step 1: Create a Retell LLM for this client
  const llmPayload = {
    model: 'gpt-4o-mini',
    general_prompt: generalPrompt,
  };

  const llmOptions = {
    hostname: 'api.retellai.com',
    port: 443,
    path: '/create-retell-llm',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };

  const llmResponse = await httpsRequest(llmOptions, llmPayload);
  if (llmResponse.status !== 200 && llmResponse.status !== 201) {
    throw new AppError('INTERNAL_ERROR', `Retell LLM creation failed (${llmResponse.status}): ${JSON.stringify(llmResponse.body || llmResponse.parseError)}`, 500);
  }

  const llmId = llmResponse.body.llm_id;
  if (!llmId) {
    throw new AppError('INTERNAL_ERROR', 'Retell LLM creation returned no llm_id', 500);
  }

  // Step 2: Create the agent with the LLM ID
  const agentPayload = {
    agent_name: businessName,
    voice_id: voiceId || '11labs-Adrian',
    language: language || 'en-US',
    response_engine: {
      type: 'retell-llm',
      llm_id: llmId,
    },
  };

  const agentOptions = {
    hostname: 'api.retellai.com',
    port: 443,
    path: '/create-agent',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };

  const agentResponse = await httpsRequest(agentOptions, agentPayload);
  if (agentResponse.status !== 200 && agentResponse.status !== 201) {
    throw new AppError('INTERNAL_ERROR', `Retell agent creation failed (${agentResponse.status}): ${JSON.stringify(agentResponse.body || agentResponse.parseError)}`, 500);
  }

  return {
    agentId: agentResponse.body.agent_id || agentResponse.body.id,
    llmId: llmId
  };
}

/**
 * POST / — Provision a new client with Telnyx number, Retell agent, and knowledge base
 */
router.post('/', validateBody(ProvisionSchema), async (req, res, next) => {
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
      ticket_price,
      business_address,
      website,
      booking_link,
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

    // Helper to broadcast progress
    const sendUpdate = (stage, status, extra = {}) => {
      broadcast('provisioning_update', {
        businessName: business_name,
        stage,
        status,
        ...extra
      });
    };

    // Step 1: Create Retell agent (optional, don't fail overall provisioning if this fails)
    let retellAgentId = null;
    let retellLlmId = null;
    try {
      sendUpdate('creating_agent', 'in_progress');
      logger.info(`[provision] Creating Retell agent for ${business_name}...`);
      
      // Merge top-level fields into knowledge_base for comprehensive prompting
      const kbForPrompt = {
        ...(knowledge_base || {}),
        business_name,
        industry,
        owner_name,
        business_address,
        website,
        booking_link,
        ticket_price,
        avg_ticket,
      };
      
      const retellData = await createRetellAgent(business_name, kbForPrompt, req.body.retell_voice, req.body.retell_language);
      retellAgentId = retellData.agentId;
      retellLlmId = retellData.llmId;
      provisioning_status.retell_agent_id = retellAgentId;
      logger.info(`[provision] Successfully created Retell agent: ${retellAgentId} (LLM: ${retellLlmId})`);
      sendUpdate('creating_agent', 'completed');
    } catch (err) {
      provisioning_status.retell_error = err.message;
      logger.error(`[provision] Retell provisioning failed: ${err.message}`);
      sendUpdate('creating_agent', 'failed', { error: err.message });
      // Don't return — allow client creation without Retell
    }

    // Step 2: Auto-provision dedicated phone number (Twilio + SIP trunk → Retell)
    let provisionedNumber = null;
    if (retellAgentId && process.env.TWILIO_ACCOUNT_SID) {
      try {
        sendUpdate('buying_number', 'in_progress');
        const { provisionUnifiedNumber } = require('../utils/twilioProvisioning');
        const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : process.env.BASE_URL || 'http://localhost:3001';

        provisionedNumber = await provisionUnifiedNumber({
          businessName: business_name,
          retellSipUri: `sip:${retellAgentId}@in.retellai.com`,
          smsWebhookUrl: `${baseUrl}/webhooks/twilio`,
          countryCode: 'US',
          areaCode: area_code || undefined,
        }, (log) => {
          logger.info(`[provision] ${log}`);
          sendUpdate('buying_number', 'in_progress', { log });
        });
        provisioning_status.phone_number = provisionedNumber.phoneNumber;
        logger.info(`[provision] Dedicated number provisioned: ${provisionedNumber.phoneNumber}`);
        sendUpdate('buying_number', 'completed', { log: 'Phone number provisioned successfully.' });
      } catch (err) {
        provisioning_status.phone_error = err.message;
        logger.warn(`[provision] Phone provisioning failed (non-fatal): ${err.message}`);
        sendUpdate('buying_number', 'failed', { error: err.message });
        // Fall back to shared number
      }
    } else {
       // Skip buying number if no retell agent or no sid
       sendUpdate('buying_number', 'completed', { skipped: true });
    }

    const phoneNumber = provisionedNumber?.phoneNumber || process.env.TWILIO_PHONE_NUMBER || null;
    provisioning_status.phone_number = phoneNumber;

    // Step 3: Save client to database
    try {
      sendUpdate('creating_client', 'in_progress');
      await db.query(`
        INSERT INTO clients (
          id, business_name, owner_name, owner_phone, owner_email,
          retell_agent_id, retell_llm_id, twilio_phone, phone_number, industry, timezone,
          avg_ticket, ticket_price, business_address, website, booking_link,
          plan, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        clientId,
        business_name,
        owner_name || null,
        owner_phone,
        owner_email || null,
        retellAgentId || null,
        retellLlmId || null,
        phoneNumber,
        phoneNumber,
        industry || null,
        timezone || 'UTC',
        avg_ticket || 0,
        ticket_price || null,
        business_address || null,
        website || null,
        booking_link || null,
        plan || 'pro',
        now,
        now
      ], 'run');

      provisioning_status.db_save = true;
      logger.info(`[provision] Successfully saved client to database: ${clientId}`);
      sendUpdate('creating_client', 'completed');
      try { logDataMutation(db, { action: 'client_created', table: 'clients', recordId: clientId, newValues: { business_name, owner_phone, plan, industry }, ip: req.ip }); } catch (_) {}
    } catch (err) {
      provisioning_status.db_error = err.message;
      logger.error(`[provision] Database save failed: ${err.message}`);
      sendUpdate('creating_client', 'failed', { error: err.message });
      return res.status(500).json({
        error: 'Failed to save client to database',
        message: process.env.NODE_ENV !== 'production' ? err.message : undefined,
        provisioning_status,
      });
    }

    // Step 4: Save knowledge base JSON
    if (knowledge_base) {
      try {
        sendUpdate('syncing_kb', 'in_progress');
        const kbDir = path.join(__dirname, '../../mcp/knowledge_bases');
        await fs.promises.mkdir(kbDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(kbDir, `${clientId}.json`),
          JSON.stringify(knowledge_base, null, 2)
        );
        provisioning_status.kb_save = true;
        logger.info(`[provision] Successfully saved knowledge base: ${clientId}.json`);
        sendUpdate('syncing_kb', 'completed');
      } catch (err) {
        provisioning_status.kb_error = err.message;
        logger.error(`[provision] Knowledge base save failed: ${err.message}`);
        sendUpdate('syncing_kb', 'failed', { error: err.message });
        // Don't fail the entire provisioning for KB save failures
      }
    } else {
      sendUpdate('syncing_kb', 'completed', { skipped: true });
    }

    // Retrieve the full client record
    const client = await db.query('SELECT id, business_name, owner_name, owner_email, owner_phone, industry, timezone, plan, retell_agent_id, retell_phone, twilio_phone, phone_number, is_active, created_at FROM clients WHERE id = ?', [clientId], 'get');

    // Generate Telegram onboarding link
    sendUpdate('setting_up_telegram', 'in_progress');
    const telegram_link = getOnboardingLink(clientId);
    provisioning_status.telegram_link = telegram_link;

    logger.info(`[provision] Provisioning complete for ${business_name} (${clientId})`);
    logger.info(`[provision] Telegram link: ${telegram_link}`);
    sendUpdate('setting_up_telegram', 'completed');

    // Post-signup: create Google Sheet (non-blocking)
    try {
      const { createClientSheet, isConfigured } = require('../utils/googleSheets');
      if (isConfigured() && owner_email) {
        sendUpdate('creating_sheet', 'in_progress');
        createClientSheet(business_name, owner_email).then(async (sheet) => {
          if (sheet) {
            await db.query("UPDATE clients SET google_sheet_id = ?, updated_at = ? WHERE id = ?",
              [sheet.spreadsheetId, new Date().toISOString(), clientId], 'run');
            sendUpdate('creating_sheet', 'completed');
          } else {
            sendUpdate('creating_sheet', 'failed', { error: 'Sheet creation returned null' });
          }
        }).catch((err) => {
          logger.warn(`[provision] Google Sheet creation failed: ${err.message}`);
          sendUpdate('creating_sheet', 'failed', { error: err.message });
        });
      } else {
        sendUpdate('creating_sheet', 'completed', { skipped: true });
      }
    } catch (_) {
      sendUpdate('creating_sheet', 'completed', { skipped: true });
    }

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
