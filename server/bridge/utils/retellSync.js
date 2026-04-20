'use strict';

const path = require('path');
const fs = require('fs').promises;
const { logger } = require('./logger');

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_BASE = 'https://api.retellai.com';

/**
 * Helper for Retell API calls using fetch
 */
async function retellRequest(path, method, body = null) {
  if (!RETELL_API_KEY) {
    throw new Error('RETELL_API_KEY is not configured');
  }

  const url = `${RETELL_BASE}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Retell API error (${resp.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Formats KB JSON into a structured system prompt.
 */
function generateRetellPrompt(kb) {
  if (!kb) return 'You are a professional AI receptionist. Be friendly and helpful.';

  const {
    business_name = 'the business',
    industry,
    services = [],
    faq = [],
    business_hours,
    booking_info,
    greeting,
    // Enhanced fields
    business_address,
    website,
    booking_link,
    calcom_booking_link,
    ticket_price,
    owner_name
  } = kb;

  let prompt = `You are a professional AI receptionist for ${business_name}${industry ? ` in the ${industry} industry` : ''}.\n\n`;

  if (greeting) {
    prompt += `## Greeting\n${greeting}\n\n`;
  }

  if (owner_name) {
    prompt += `## Business Owner\n${owner_name}\n\n`;
  }

  if (business_address) {
    prompt += `## Address\n${business_address}\n\n`;
  }

  if (website) {
    prompt += `## Website\n${website}\n\n`;
  }

  if (services && services.length > 0) {
    prompt += `## Services Offered\n${services.map(s => `- ${s}`).join('\n')}\n\n`;
  }

  if (ticket_price) {
    prompt += `## Pricing\nTypical service price starts at around $${ticket_price}.\n\n`;
  }

  if (business_hours) {
    prompt += `## Business Hours\n${business_hours}\n\n`;
  }

  const activeBookingLink = booking_link || calcom_booking_link;
  if (activeBookingLink || booking_info) {
    prompt += `## Booking Information\n${activeBookingLink ? `Book online: ${activeBookingLink}\n` : ''}${booking_info || ''}\n\n`;
  }

  if (faq && faq.length > 0) {
    prompt += `## Frequently Asked Questions\n${faq.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}\n\n`;
  }

  prompt += "## Style Guidelines\n";
  prompt += "- Always be professional, friendly, and concise.\n";
  prompt += "- Collect caller's name and reason for calling.\n";
  prompt += "- Offer to book an appointment if relevant to the services offered.\n";
  prompt += "- If the caller asks for someone specific or needs technical help, offer to take a message or transfer them if appropriate.\n";
  prompt += "- Do not make up information that is not in this knowledge base.";

  return prompt;
}

/**
 * Fetches KB and client data, then updates the Retell LLM.
 */
async function syncClientToRetell(clientId, db) {
  try {
    logger.info(`[retellSync] Starting sync for client ${clientId}`);

    // 1. Get client data from DB
    const client = await db.query(`
      SELECT business_name, industry, owner_name, business_address, website, 
             booking_link, calcom_booking_link, ticket_price, 
             retell_agent_id, retell_llm_id 
      FROM clients WHERE id = ?
    `, [clientId], 'get');
    
    if (!client) {
      logger.warn(`[retellSync] Client not found: ${clientId}`);
      return;
    }

    if (!client.retell_agent_id) {
      logger.info(`[retellSync] Client ${clientId} has no Retell agent ID. Skipping sync.`);
      return;
    }

    // 2. Resolve LLM ID if not in DB
    let llmId = client.retell_llm_id;
    if (!llmId) {
      logger.info(`[retellSync] Fetching LLM ID for agent ${client.retell_agent_id}`);
      try {
        const agentData = await retellRequest(`/get-agent/${client.retell_agent_id}`, 'GET');
        llmId = agentData.response_engine?.llm_id;
        if (llmId) {
          // Backfill llm_id
          await db.query('UPDATE clients SET retell_llm_id = ? WHERE id = ?', [llmId, clientId], 'run');
          logger.info(`[retellSync] Backfilled retell_llm_id for client ${clientId}: ${llmId}`);
        }
      } catch (err) {
        logger.error(`[retellSync] Failed to fetch agent data for ${client.retell_agent_id}: ${err.message}`);
      }
    }

    if (!llmId) {
      logger.warn(`[retellSync] Could not resolve LLM ID for client ${clientId}`);
      return;
    }

    // 3. Load KB from file
    const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${clientId}.json`);
    let kb = {};
    try {
      const kbContent = await fs.readFile(kbPath, 'utf8');
      kb = JSON.parse(kbContent);
    } catch (err) {
      logger.warn(`[retellSync] Knowledge base file not found or invalid for ${clientId}: ${err.message}`);
    }

    // 4. Merge DB data (DB is source of truth for these fields)
    kb.business_name = client.business_name || kb.business_name;
    kb.industry = client.industry || kb.industry;
    kb.owner_name = client.owner_name || kb.owner_name;
    kb.business_address = client.business_address || kb.business_address;
    kb.website = client.website || kb.website;
    kb.booking_link = client.booking_link || kb.booking_link;
    kb.calcom_booking_link = client.calcom_booking_link || kb.calcom_booking_link;
    kb.ticket_price = client.ticket_price || kb.ticket_price;

    // 5. Generate prompt
    const generalPrompt = generateRetellPrompt(kb);

    // 6. Update Retell LLM
    logger.info(`[retellSync] Updating Retell LLM ${llmId} for client ${clientId}`);
    await retellRequest(`/update-retell-llm/${llmId}`, 'PATCH', {
      general_prompt: generalPrompt
    });

    logger.info(`[retellSync] Successfully synced client ${clientId} to Retell`);
    return { success: true };
  } catch (err) {
    logger.error(`[retellSync] Error syncing client ${clientId} to Retell:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  generateRetellPrompt,
  syncClientToRetell
};
