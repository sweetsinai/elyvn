const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getBookings } = require('../utils/calcom');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const anthropic = new Anthropic();
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /stats/:clientId
router.get('/stats/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

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

    // Leads by stage
    const stages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
    const leadsByStage = {};
    for (const stage of stages) {
      leadsByStage[stage] = db.prepare(
        'SELECT COUNT(*) as count FROM leads WHERE client_id = ? AND stage = ?'
      ).get(clientId, stage).count;
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
    console.error('[api] stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /calls/:clientId
router.get('/calls/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { outcome, startDate, endDate, minScore } = req.query;
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (pageNum - 1) * limitNum;
    const conditions = ['client_id = ?'];
    const params = [clientId];

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

    const total = db.prepare(`SELECT COUNT(*) as count FROM calls WHERE ${where}`).get(...params).count;

    const calls = db.prepare(
      `SELECT id, call_id, caller_phone, direction, duration, outcome, summary, score, sentiment, created_at
       FROM calls WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limitNum, offset);

    const totalPages = Math.ceil(total / limitNum);
    res.json({ calls, total, page: pageNum, limit: limitNum, total_pages: totalPages });
  } catch (err) {
    console.error('[api] calls error:', err);
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
    console.error('[api] transcript error:', err);
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

// GET /messages/:clientId
router.get('/messages/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { status, startDate, endDate } = req.query;
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (pageNum - 1) * limitNum;
    const conditions = ['client_id = ?'];
    const params = [clientId];

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

    const total = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE ${where}`).get(...params).count;

    const messages = db.prepare(
      `SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limitNum, offset);

    const totalPages = Math.ceil(total / limitNum);
    res.json({ messages, total, page: pageNum, limit: limitNum, total_pages: totalPages });
  } catch (err) {
    console.error('[api] messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /leads/:clientId
router.get('/leads/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { stage, minScore, search } = req.query;
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (pageNum - 1) * limitNum;
    const conditions = ['client_id = ?'];
    const params = [clientId];

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
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    const where = conditions.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as count FROM leads WHERE ${where}`).get(...params).count;

    const leads = db.prepare(
      `SELECT * FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limitNum, offset);

    // Attach recent interactions to each lead
    const leadsWithInteractions = leads.map(lead => {
      const recentCalls = db.prepare(
        'SELECT id, call_id, duration, outcome, summary, score, created_at FROM calls WHERE client_id = ? AND caller_phone = ? ORDER BY created_at DESC LIMIT 3'
      ).all(clientId, lead.phone);

      const recentMessages = db.prepare(
        'SELECT id, direction, body, created_at FROM messages WHERE client_id = ? AND phone = ? ORDER BY created_at DESC LIMIT 3'
      ).all(clientId, lead.phone);

      return { ...lead, recent_calls: recentCalls, recent_messages: recentMessages };
    });

    const totalPages = Math.ceil(total / limitNum);
    res.json({ leads: leadsWithInteractions, total, page: pageNum, limit: limitNum, total_pages: totalPages });
  } catch (err) {
    console.error('[api] leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// PUT /leads/:clientId/:leadId
router.put('/leads/:clientId/:leadId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;
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
    console.error('[api] update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// GET /bookings/:clientId
router.get('/bookings/:clientId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { startDate, endDate } = req.query;

    const client = db.prepare('SELECT calcom_event_type_id FROM clients WHERE id = ?').get(clientId);
    if (!client?.calcom_event_type_id) {
      return res.json({ bookings: [] });
    }

    const bookings = await getBookings(client.calcom_event_type_id, startDate, endDate);
    res.json({ bookings });
  } catch (err) {
    console.error('[api] bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET /reports/:clientId
router.get('/reports/:clientId', (req, res) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    const reports = db.prepare(
      'SELECT * FROM weekly_reports WHERE client_id = ? ORDER BY created_at DESC LIMIT 12'
    ).all(clientId);

    res.json({ reports });
  } catch (err) {
    console.error('[api] reports error:', err);
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
    console.error('[api] clients error:', err);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// POST /clients
router.post('/clients', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const {
      business_name, owner_name, owner_phone, owner_email,
      retell_agent_id, retell_phone, twilio_phone, industry, timezone,
      calcom_event_type_id, calcom_booking_link,
      avg_ticket, knowledge_base
    } = req.body;

    if (!business_name) {
      return res.status(400).json({ error: 'business_name is required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO clients (
        id, business_name, owner_name, owner_phone, owner_email,
        retell_agent_id, retell_phone, twilio_phone, industry, timezone,
        calcom_event_type_id, calcom_booking_link,
        avg_ticket, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, business_name, owner_name || null, owner_phone || null, owner_email || null,
      retell_agent_id || null, retell_phone || null, twilio_phone || null, industry || null, timezone || 'UTC',
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
        console.error('[api] Failed to save KB:', err.message);
      }
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    res.status(201).json({ client });
  } catch (err) {
    console.error('[api] create client error:', err);
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

    const allowedFields = [
      'business_name', 'owner_name', 'owner_phone', 'owner_email',
      'retell_agent_id', 'retell_phone', 'twilio_phone', 'industry', 'timezone',
      'calcom_event_type_id', 'calcom_booking_link', 'telegram_chat_id',
      'avg_ticket', 'is_active'
    ];

    const setClauses = [];
    const values = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        values.push(updates[field]);
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
        console.error('[api] Failed to save KB:', err.message);
      }
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    res.json({ client });
  } catch (err) {
    console.error('[api] update client error:', err);
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

    // Load client KB as system context
    let systemPrompt = 'You are an AI assistant for the ELYVN operations dashboard.';

    if (clientId && UUID_RE.test(clientId)) {
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
      if (client) {
        systemPrompt += `\n\nYou are assisting with ${client.business_name}.`;
      }

      const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${clientId}.json`);
      try {
        const kbData = fs.readFileSync(kbPath, 'utf8');
        systemPrompt += `\n\nBusiness Knowledge Base:\n${kbData}`;
      } catch (_) {}

      // Add recent stats context
      try {
        const callCount = db.prepare('SELECT COUNT(*) as count FROM calls WHERE client_id = ?').get(clientId).count;
        const leadCount = db.prepare('SELECT COUNT(*) as count FROM leads WHERE client_id = ?').get(clientId).count;
        systemPrompt += `\n\nCurrent stats: ${callCount} total calls, ${leadCount} total leads.`;
      } catch (_) {}
    }

    // Stream response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = anthropic.messages.stream({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    stream.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error('[api] chat stream error:', err);
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    console.error('[api] chat error:', err);
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
    console.error('[api] intelligence error:', err);
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
    console.error('[api] peak-hours error:', err);
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
    console.error('[api] response-impact error:', err);
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
    console.error('[api] scoring error:', err);
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
    console.error('[api] lead score error:', err);
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
    console.error('[api] conversion analytics error:', err);
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
    console.error('[api] revenue error:', err);
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
    console.error('[api] attribution error:', err);
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
    console.error('[api] channel performance error:', err);
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
    console.error('[api] schedule error:', err);
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
    console.error('[api] time-slots error:', err);
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
