const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getBookings } = require('../utils/calcom');
const config = require('../utils/config');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { isValidUUID, escapeLikePattern } = require('../utils/validate');
const { withTimeout } = require('../utils/resilience');
const { logger } = require('../utils/logger');
const { validateEmail, validatePhone, validateLength, sanitizeString, LENGTH_LIMITS, validateParameters } = require('../utils/inputValidation');

const anthropic = new Anthropic();
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ANTHROPIC_TIMEOUT = 30000;

// Whitelist of allowed client fields for updates (prevents SQL injection)
const ALLOWED_CLIENT_FIELDS = new Set([
  'business_name', 'business_address', 'phone', 'email', 'website',
  'google_review_link', 'ticket_price', 'timezone', 'ai_enabled',
  'booking_link', 'industry', 'auto_followup_enabled',
  'owner_name', 'owner_phone', 'owner_email',
  'retell_agent_id', 'retell_phone', 'twilio_phone', 'transfer_phone',
  'calcom_event_type_id', 'calcom_booking_link', 'telegram_chat_id',
  'avg_ticket', 'is_active', 'plan'
]);

// Helper to safely build SQL where clauses with parameterized queries
function buildWhereClause(conditions) {
  if (conditions.length === 0) return { where: '1=1', params: [] };
  return {
    where: conditions.map(c => c.condition).join(' AND '),
    params: conditions.flatMap(c => c.params)
  };
}

// GET /stats/:clientId
router.get('/stats/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfLastWeek = new Date(startOfWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    const thisWeekStr = startOfWeek.toISOString();
    const lastWeekStr = startOfLastWeek.toISOString();

    // Calls
    const callsThisWeek = db.prepare(
      'SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND created_at >= ?'
    ).get(clientId, thisWeekStr).count;

    const callsLastWeek = db.prepare(
      'SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND created_at >= ? AND created_at < ?'
    ).get(clientId, lastWeekStr, thisWeekStr).count;

    const callsTrend = callsLastWeek > 0
      ? Math.round(((callsThisWeek - callsLastWeek) / callsLastWeek) * 100)
      : callsThisWeek > 0 ? 100 : 0;

    // Messages
    const messagesThisWeek = db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND created_at >= ?'
    ).get(clientId, thisWeekStr).count;

    const messagesLastWeek = db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND created_at >= ? AND created_at < ?'
    ).get(clientId, lastWeekStr, thisWeekStr).count;

    const messagesTrend = messagesLastWeek > 0
      ? Math.round(((messagesThisWeek - messagesLastWeek) / messagesLastWeek) * 100)
      : messagesThisWeek > 0 ? 100 : 0;

    // Bookings
    const bookingsThisWeek = db.prepare(
      "SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?"
    ).get(clientId, thisWeekStr).count;

    // Revenue estimate
    const client = db.prepare('SELECT avg_ticket FROM clients WHERE id = ?').get(clientId);
    const avgTicket = client?.avg_ticket || 0;
    const estimatedRevenue = bookingsThisWeek * avgTicket;

    // Leads by stage — single GROUP BY query instead of N+1
    const stages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
    const leadsByStage = {};
    stages.forEach(s => { leadsByStage[s] = 0; });
    const stageRows = db.prepare(
      'SELECT stage, COUNT(*) as count FROM leads WHERE client_id = ? GROUP BY stage'
    ).all(clientId);
    for (const row of stageRows) {
      if (stages.includes(row.stage)) leadsByStage[row.stage] = row.count;
    }

    res.json({
      calls_this_week: callsThisWeek,
      calls_last_week: callsLastWeek,
      calls_trend: callsTrend,
      messages_this_week: messagesThisWeek,
      messages_last_week: messagesLastWeek,
      messages_trend: messagesTrend,
      bookings_this_week: bookingsThisWeek,
      estimated_revenue: estimatedRevenue,
      leads_by_stage: leadsByStage
    });
  } catch (err) {
    logger.error('[api] stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /calls/:clientId
router.get('/calls/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const { outcome, startDate, endDate, minScore } = req.query;
    const pageNum = Math.max(1, Math.min(10000, parseInt(req.query.page) || 1));
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    if (isNaN(pageNum) || isNaN(limitNum)) {
      return res.status(400).json({ error: 'Invalid pagination parameters' });
    }
    const offset = (pageNum - 1) * limitNum;
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
    const total = db.prepare(`SELECT COUNT(*) as count FROM calls WHERE ${where}`).get(...countParams).count;

    const queryParams = [...params, limitNum, offset];
    const calls = db.prepare(
      `SELECT id, call_id, caller_phone, direction, duration, outcome, summary, score, sentiment, created_at
       FROM calls WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...queryParams);

    const totalPages = Math.ceil(total / limitNum);
    res.json({ calls, total, page: pageNum, limit: limitNum, total_pages: totalPages });
  } catch (err) {
    logger.error('[api] calls error:', err);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// GET /calls/:clientId/:callId/transcript
router.get('/calls/:clientId/:callId/transcript', async (req, res) => {
  try {
    const { callId } = req.params;

    const retellResp = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` }
    });

    if (!retellResp.ok) {
      return res.status(retellResp.status).json({ error: 'Failed to fetch transcript from Retell' });
    }

    const callData = await retellResp.json();
    res.json({ transcript: callData.transcript || [] });
  } catch (err) {
    logger.error('[api] transcript error:', err);
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

// GET /calls/:clientId/:callId/transcript/download — download as .txt file
router.get('/calls/:clientId/:callId/transcript/download', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, callId } = req.params;

    // Try local DB first (faster), fallback to Retell API
    const localCall = db.prepare(
      'SELECT transcript, caller_phone, created_at, summary FROM calls WHERE call_id = ? AND client_id = ?'
    ).get(callId, clientId);

    let transcriptText = '';
    let callerPhone = localCall?.caller_phone || 'unknown';
    let callDate = localCall?.created_at || new Date().toISOString();
    let summary = localCall?.summary || '';

    if (localCall?.transcript && localCall.transcript.trim().length > 10) {
      transcriptText = localCall.transcript;
    } else {
      // Fallback: fetch from Retell
      const retellResp = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
        headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` }
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
      '─'.repeat(50),
      '',
    ].filter(Boolean).join('\n');

    const fileContent = header + transcriptText;
    const filename = `transcript-${callId.substring(0, 8)}-${callDate.split('T')[0]}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fileContent);
  } catch (err) {
    logger.error('[api] transcript download error:', err);
    res.status(500).json({ error: 'Failed to download transcript' });
  }
});

// GET /messages/:clientId
router.get('/messages/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const { status, startDate, endDate } = req.query;
    const pageNum = Math.max(1, Math.min(10000, parseInt(req.query.page) || 1));
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    if (isNaN(pageNum) || isNaN(limitNum)) {
      return res.status(400).json({ error: 'Invalid pagination parameters' });
    }
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    const params = [clientId];

    conditions.push('client_id = ?');

    if (status) {
      conditions.push('direction = ?');
      params.push(status);
    }
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }

    const where = conditions.join(' AND ');

    const countParams = [...params];
    const total = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE ${where}`).get(...countParams).count;

    const queryParams = [...params, limitNum, offset];
    const messages = db.prepare(
      `SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...queryParams);

    const totalPages = Math.ceil(total / limitNum);
    res.json({ messages, total, page: pageNum, limit: limitNum, total_pages: totalPages });
  } catch (err) {
    logger.error('[api] messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /leads/:clientId
router.get('/leads/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const { stage, minScore, search } = req.query;
    const pageNum = Math.max(1, Math.min(10000, parseInt(req.query.page) || 1));
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    if (isNaN(pageNum) || isNaN(limitNum)) {
      return res.status(400).json({ error: 'Invalid pagination parameters' });
    }
    const offset = (pageNum - 1) * limitNum;
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

    const countParams = [...params];
    const total = db.prepare(`SELECT COUNT(*) as count FROM leads WHERE ${where}`).get(...countParams).count;

    const queryParams = [...params, limitNum, offset];
    const leads = db.prepare(
      `SELECT * FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...queryParams);

    // Batch-load recent interactions for all leads in a single query per table
    // Build parameterized IN clause to prevent SQL injection
    let allCalls = [];
    let allMessages = [];

    if (leads.length > 0) {
      const placeholders = leads.map(() => '?').join(',');
      const callParams = [clientId, ...leads.map(l => l.phone)];
      allCalls = db.prepare(`
        SELECT id, call_id, duration, outcome, summary, score, created_at, caller_phone
        FROM calls
        WHERE client_id = ? AND caller_phone IN (${placeholders})
        ORDER BY created_at DESC LIMIT 500
      `).all(...callParams);

      const messageParams = [clientId, ...leads.map(l => l.phone)];
      allMessages = db.prepare(`
        SELECT id, direction, body, created_at, phone
        FROM messages
        WHERE client_id = ? AND phone IN (${placeholders})
        ORDER BY created_at DESC LIMIT 500
      `).all(...messageParams);
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

    const totalPages = Math.ceil(total / limitNum);
    res.json({ leads: leadsWithInteractions, total, page: pageNum, limit: limitNum, total_pages: totalPages });
  } catch (err) {
    logger.error('[api] leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// PUT /leads/:clientId/:leadId
router.put('/leads/:clientId/:leadId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    // Validate clientId and leadId format
    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return res.status(400).json({ error: 'Invalid client ID or lead ID format' });
    }

    const { stage } = req.body;

    const validStages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ error: `Invalid stage. Must be one of: ${validStages.join(', ')}` });
    }

    const result = db.prepare(
      'UPDATE leads SET stage = ?, updated_at = ? WHERE id = ? AND client_id = ?'
    ).run(stage, new Date().toISOString(), leadId, clientId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ success: true, stage });
  } catch (err) {
    logger.error('[api] update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// GET /bookings/:clientId
router.get('/bookings/:clientId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const { startDate, endDate } = req.query;

    // Validate date parameters if provided (ISO 8601 format)
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;
    if (startDate && !isoDateRegex.test(startDate)) {
      return res.status(400).json({ error: 'Invalid startDate format. Use ISO 8601 (YYYY-MM-DD)' });
    }
    if (endDate && !isoDateRegex.test(endDate)) {
      return res.status(400).json({ error: 'Invalid endDate format. Use ISO 8601 (YYYY-MM-DD)' });
    }

    const client = db.prepare('SELECT calcom_event_type_id FROM clients WHERE id = ?').get(clientId);
    if (!client?.calcom_event_type_id) {
      return res.json({ bookings: [] });
    }

    const bookings = await getBookings(client.calcom_event_type_id, startDate, endDate);
    res.json({ bookings });
  } catch (err) {
    logger.error('[api] bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET /reports/:clientId
router.get('/reports/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format' });
    }

    const reports = db.prepare(
      'SELECT * FROM weekly_reports WHERE client_id = ? ORDER BY created_at DESC LIMIT 12'
    ).all(clientId);

    res.json({ reports });
  } catch (err) {
    logger.error('[api] reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// GET /clients
router.get('/clients', (req, res) => {
  try {
    const db = req.app.locals.db;
    const clients = db.prepare('SELECT * FROM clients ORDER BY created_at DESC LIMIT 100').all();
    res.json({ clients });
  } catch (err) {
    logger.error('[api] clients error:', err);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// POST /clients
router.post('/clients', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const {
      business_name, owner_name, owner_phone, owner_email,
      retell_agent_id, retell_phone, twilio_phone, transfer_phone, industry, timezone,
      calcom_event_type_id, calcom_booking_link,
      avg_ticket, knowledge_base
    } = req.body;

    // Validate required business_name
    if (!business_name) {
      return res.status(400).json({ error: 'business_name is required' });
    }

    // Validate input lengths
    const nameValidation = validateLength(business_name, 'business_name', LENGTH_LIMITS.name);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // Validate owner_email if provided
    if (owner_email) {
      const emailValidation = validateEmail(owner_email);
      if (!emailValidation.valid) {
        return res.status(400).json({ error: emailValidation.error });
      }
    }

    // Validate owner_phone if provided
    if (owner_phone) {
      const phoneValidation = validatePhone(owner_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: phoneValidation.error });
      }
    }

    // Validate other phone fields if provided
    if (retell_phone) {
      const phoneValidation = validatePhone(retell_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: `Invalid retell_phone: ${phoneValidation.error}` });
      }
    }

    if (twilio_phone) {
      const phoneValidation = validatePhone(twilio_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: `Invalid twilio_phone: ${phoneValidation.error}` });
      }
    }

    if (transfer_phone) {
      const phoneValidation = validatePhone(transfer_phone);
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: `Invalid transfer_phone: ${phoneValidation.error}` });
      }
    }

    // Validate optional text fields
    if (owner_name) {
      const validation = validateLength(owner_name, 'owner_name', LENGTH_LIMITS.name);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    if (industry) {
      const validation = validateLength(industry, 'industry', LENGTH_LIMITS.name);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    if (calcom_booking_link) {
      const validation = validateLength(calcom_booking_link, 'calcom_booking_link', LENGTH_LIMITS.url);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO clients (
        id, business_name, owner_name, owner_phone, owner_email,
        retell_agent_id, retell_phone, twilio_phone, transfer_phone, industry, timezone,
        calcom_event_type_id, calcom_booking_link,
        avg_ticket, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, business_name, owner_name || null, owner_phone || null, owner_email || null,
      retell_agent_id || null, retell_phone || null, twilio_phone || null, transfer_phone || null, industry || null, timezone || 'UTC',
      calcom_event_type_id || null, calcom_booking_link || null,
      avg_ticket || 0, now, now
    );

    // Save knowledge base JSON if provided (UUID validated — id is from randomUUID())
    if (knowledge_base) {
      const kbDir = path.join(__dirname, '../../mcp/knowledge_bases');
      try {
        await fsPromises.mkdir(kbDir, { recursive: true });
        await fsPromises.writeFile(path.join(kbDir, `${id}.json`), JSON.stringify(knowledge_base, null, 2));
      } catch (err) {
        logger.error('[api] Failed to save KB:', err.message);
      }
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    res.status(201).json({ client });
  } catch (err) {
    logger.error('[api] create client error:', err);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// PUT /clients/:clientId
router.put('/clients/:clientId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'Invalid client ID format' });
    const updates = req.body;

    const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!existing) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const setClauses = [];
    const values = [];

    // Only allow whitelisted fields to prevent SQL injection
    for (const field in updates) {
      if (ALLOWED_CLIENT_FIELDS.has(field) && updates[field] !== undefined) {
        const value = updates[field];

        // Validate field lengths and formats based on field type
        if (field === 'business_name' && value) {
          const validation = validateLength(value, field, LENGTH_LIMITS.name);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        if (field === 'email' && value) {
          const validation = validateEmail(value);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        if (field === 'owner_email' && value) {
          const validation = validateEmail(value);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        if (['phone', 'owner_phone', 'retell_phone', 'twilio_phone', 'transfer_phone'].includes(field) && value) {
          const validation = validatePhone(value);
          if (!validation.valid) {
            return res.status(400).json({ error: `Invalid ${field}: ${validation.error}` });
          }
        }

        if (['business_address', 'owner_name', 'industry', 'website', 'google_review_link', 'calcom_booking_link', 'booking_link'].includes(field) && value) {
          const validation = validateLength(value, field, LENGTH_LIMITS.text);
          if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
          }
        }

        setClauses.push(`${field} = ?`);
        values.push(value);
      }
    }

    if (setClauses.length === 0 && !updates.knowledge_base) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    if (setClauses.length > 0) {
      setClauses.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(clientId);

      db.prepare(`UPDATE clients SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    }

    // Update knowledge base if provided
    if (updates.knowledge_base) {
      const kbDir = path.join(__dirname, '../../mcp/knowledge_bases');
      try {
        await fsPromises.mkdir(kbDir, { recursive: true });
        await fsPromises.writeFile(path.join(kbDir, `${clientId}.json`), JSON.stringify(updates.knowledge_base, null, 2));
      } catch (err) {
        logger.error('[api] Failed to save KB:', err.message);
      }
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    res.json({ client });
  } catch (err) {
    logger.error('[api] update client error:', err);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

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
        const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${clientId}.json`);
        try {
          // Verify path doesn't escape knowledge_bases directory
          const resolvedPath = path.resolve(kbPath);
          const kbDir = path.resolve(path.join(__dirname, '../../mcp/knowledge_bases'));
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

// =============================================
// INTELLIGENCE & ANALYTICS ENDPOINTS
// =============================================

// GET /intelligence/:clientId — Full conversation intelligence report
router.get('/intelligence/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

    const { getConversationIntelligence } = require('../utils/conversationIntelligence');
    const report = getConversationIntelligence(db, clientId, days);
    res.json(report);
  } catch (err) {
    logger.error('[api] intelligence error:', err);
    res.status(500).json({ error: 'Failed to generate intelligence report' });
  }
});

// GET /intelligence/:clientId/peak-hours — Peak activity hours
router.get('/intelligence/:clientId/peak-hours', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { getPeakHours } = require('../utils/conversationIntelligence');
    const peakHours = getPeakHours(db, clientId);
    res.json({ peak_hours: peakHours });
  } catch (err) {
    logger.error('[api] peak-hours error:', err);
    res.status(500).json({ error: 'Failed to get peak hours' });
  }
});

// GET /intelligence/:clientId/response-impact — Response time impact analysis
router.get('/intelligence/:clientId/response-impact', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { analyzeResponseTimeImpact } = require('../utils/conversationIntelligence');
    const analysis = analyzeResponseTimeImpact(db, clientId);
    res.json(analysis);
  } catch (err) {
    logger.error('[api] response-impact error:', err);
    res.status(500).json({ error: 'Failed to analyze response time impact' });
  }
});

// GET /scoring/:clientId — Batch predictive scores for all active leads
router.get('/scoring/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { batchScoreLeads } = require('../utils/leadScoring');
    const scores = batchScoreLeads(db, clientId);
    res.json({ leads: scores, total: scores.length });
  } catch (err) {
    logger.error('[api] scoring error:', err);
    res.status(500).json({ error: 'Failed to score leads' });
  }
});

// GET /scoring/:clientId/:leadId — Individual lead predictive score
router.get('/scoring/:clientId/:leadId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    const { predictLeadScore } = require('../utils/leadScoring');
    const score = predictLeadScore(db, leadId, clientId);
    res.json(score);
  } catch (err) {
    logger.error('[api] lead score error:', err);
    res.status(500).json({ error: 'Failed to score lead' });
  }
});

// GET /scoring/:clientId/analytics/conversion — Conversion analytics
router.get('/scoring/:clientId/analytics/conversion', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { getConversionAnalytics } = require('../utils/leadScoring');
    const analytics = getConversionAnalytics(db, clientId);
    res.json(analytics);
  } catch (err) {
    logger.error('[api] conversion analytics error:', err);
    res.status(500).json({ error: 'Failed to get conversion analytics' });
  }
});

// GET /revenue/:clientId — Revenue attribution & ROI
router.get('/revenue/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

    const { getROIMetrics } = require('../utils/revenueAttribution');
    const metrics = getROIMetrics(db, clientId, days);
    res.json(metrics);
  } catch (err) {
    logger.error('[api] revenue error:', err);
    res.status(500).json({ error: 'Failed to get revenue metrics' });
  }
});

// GET /revenue/:clientId/:leadId — Single lead attribution chain
router.get('/revenue/:clientId/:leadId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    const { getAttribution } = require('../utils/revenueAttribution');
    const attribution = getAttribution(db, leadId, clientId);
    res.json(attribution);
  } catch (err) {
    logger.error('[api] attribution error:', err);
    res.status(500).json({ error: 'Failed to get lead attribution' });
  }
});

// GET /revenue/:clientId/channels/performance — Channel performance breakdown
router.get('/revenue/:clientId/channels/performance', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { getChannelPerformance } = require('../utils/revenueAttribution');
    const channels = getChannelPerformance(db, clientId);
    res.json(channels);
  } catch (err) {
    logger.error('[api] channel performance error:', err);
    res.status(500).json({ error: 'Failed to get channel performance' });
  }
});

// GET /schedule/:clientId — AI-generated daily contact schedule
router.get('/schedule/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { generateDailySchedule } = require('../utils/smartScheduler');
    const schedule = generateDailySchedule(db, clientId);
    res.json({ schedule, total: schedule.length });
  } catch (err) {
    logger.error('[api] schedule error:', err);
    res.status(500).json({ error: 'Failed to generate schedule' });
  }
});

// GET /schedule/:clientId/time-slots — Optimal time slot analysis
router.get('/schedule/:clientId/time-slots', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const { analyzeTimeSlotSuccess } = require('../utils/smartScheduler');
    const analysis = analyzeTimeSlotSuccess(db, clientId);
    res.json(analysis);
  } catch (err) {
    logger.error('[api] time-slots error:', err);
    res.status(500).json({ error: 'Failed to analyze time slots' });
  }
});

// GET /health/detailed — Detailed health with metrics
router.get('/health/detailed', (req, res) => {
  try {
    const { getMetrics } = require('../utils/metrics');
    const metrics = getMetrics();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      metrics,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
