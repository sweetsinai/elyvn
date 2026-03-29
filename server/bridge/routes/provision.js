const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getOnboardingLink } = require('../utils/telegram');

// Ensure the 'plan' column exists on clients table
try {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../mcp/elyvn.db');
  const Database = require('better-sqlite3');
  const initDb = new Database(dbPath);
  try {
    initDb.exec('ALTER TABLE clients ADD COLUMN plan TEXT DEFAULT "growth"');
    console.log('[provision] Ensured plan column exists on clients table');
  } catch (_) {
    // Column already exists
  }
  initDb.close();
} catch (err) {
  console.error('[provision] Failed to ensure plan column:', err.message);
}

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
async function createRetellAgent(businessName, knowledgeBaseSummary) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    throw new Error('RETELL_API_KEY is required');
  }

  const kbText = knowledgeBaseSummary || 'Help customers with their inquiries professionally and courteously.';
  const generalPrompt = `You are an AI receptionist for ${businessName}. ${kbText}`;

  const payload = {
    agent_name: businessName,
    voice_id: '11labs-Adrian',
    language: 'en-US',
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
    throw new Error(`Retell creation failed (${response.status}): ${JSON.stringify(response.body || response.parseError)}`);
  }

  return response.body.agent_id || response.body.id;
}

/**
 * POST / — Provision a new client with Telnyx number, Retell agent, and knowledge base
 */
router.post('/', async (req, res) => {
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

    console.log(`[provision] Starting provisioning for ${business_name} (${clientId})`);

    // Step 1: Create Retell agent (optional, don't fail overall provisioning if this fails)
    let retellAgentId = null;
    try {
      const kbSummary = knowledge_base
        ? `You serve ${knowledge_base.business_name || business_name}. Services: ${(knowledge_base.services || []).join(', ') || 'various services'}. Business hours: ${knowledge_base.hours || 'standard hours'}. Location: ${knowledge_base.location || 'contact for details'}.`
        : null;

      console.log(`[provision] Creating Retell agent for ${business_name}...`);
      retellAgentId = await createRetellAgent(business_name, kbSummary);
      provisioning_status.retell_agent_id = retellAgentId;
      console.log(`[provision] Successfully created Retell agent: ${retellAgentId}`);
    } catch (err) {
      provisioning_status.retell_error = err.message;
      console.error(`[provision] Retell provisioning failed: ${err.message}`);
      // Don't return — allow client creation without Retell
    }

    // Step 2: Save client to database
    try {
      db.prepare(`
        INSERT INTO clients (
          id, business_name, owner_name, owner_phone, owner_email,
          retell_agent_id, twilio_phone, industry, timezone,
          avg_ticket, plan, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        clientId,
        business_name,
        owner_name || null,
        owner_phone,
        owner_email || null,
        retellAgentId || null,
        process.env.TWILIO_PHONE_NUMBER || null,
        industry || null,
        timezone || 'UTC',
        avg_ticket || 0,
        plan || 'growth',
        now,
        now
      );

      provisioning_status.db_save = true;
      console.log(`[provision] Successfully saved client to database: ${clientId}`);
    } catch (err) {
      provisioning_status.db_error = err.message;
      console.error(`[provision] Database save failed: ${err.message}`);
      return res.status(500).json({
        error: 'Failed to save client to database',
        message: err.message,
        provisioning_status,
      });
    }

    // Step 3: Save knowledge base JSON
    if (knowledge_base) {
      try {
        const kbDir = path.join(__dirname, '../../mcp/knowledge_bases');
        if (!fs.existsSync(kbDir)) {
          fs.mkdirSync(kbDir, { recursive: true });
        }
        fs.writeFileSync(
          path.join(kbDir, `${clientId}.json`),
          JSON.stringify(knowledge_base, null, 2)
        );
        provisioning_status.kb_save = true;
        console.log(`[provision] Successfully saved knowledge base: ${clientId}.json`);
      } catch (err) {
        provisioning_status.kb_error = err.message;
        console.error(`[provision] Knowledge base save failed: ${err.message}`);
        // Don't fail the entire provisioning for KB save failures
      }
    }

    // Retrieve the full client record
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);

    // Generate Telegram onboarding link
    const telegram_link = getOnboardingLink(clientId);
    provisioning_status.telegram_link = telegram_link;

    console.log(`[provision] Provisioning complete for ${business_name} (${clientId})`);
    console.log(`[provision] Telegram link: ${telegram_link}`);

    return res.status(201).json({
      client,
      provisioning_status,
      telegram_link,
      success: provisioning_status.db_save === true,
    });
  } catch (err) {
    console.error('[provision] Unexpected error:', err);
    return res.status(500).json({
      error: 'Unexpected error during provisioning',
      message: err.message,
    });
  }
});

module.exports = router;
