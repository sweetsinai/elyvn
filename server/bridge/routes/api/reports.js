const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { CircuitBreaker } = require('../../utils/resilience');
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// Circuit breaker for Claude AI narrative — opens after 3 failures in 60s, 30s cooldown
const anthropicBreaker = new CircuitBreaker(
  async (prompt, model) => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15000 });
    return anthropic.messages.create({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    });
  },
  {
    failureThreshold: 3,
    failureWindow: 60000,
    cooldownPeriod: 30000,
    serviceName: 'Anthropic-Reports',
    fallback: () => null,
  }
);

// Per-client cache for expensive /insights endpoint (5 min TTL, max 500 entries)
const insightsCache = new Map();
const INSIGHTS_CACHE_TTL = 5 * 60 * 1000;
const INSIGHTS_CACHE_MAX = 500;

// Periodic cleanup every 5 min to prevent unbounded growth
const _insightsCacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of insightsCache) {
    if (now - v.ts > INSIGHTS_CACHE_TTL) insightsCache.delete(k);
  }
  // Hard cap: if still over max after TTL sweep, clear entirely
  if (insightsCache.size > INSIGHTS_CACHE_MAX) insightsCache.clear();
}, INSIGHTS_CACHE_TTL);
if (_insightsCacheCleanup.unref) _insightsCacheCleanup.unref();

// GET /reports/:clientId — list last 12 weekly reports
router.get('/reports/:clientId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const reports = await db.query(
      'SELECT * FROM weekly_reports WHERE client_id = ? ORDER BY created_at DESC LIMIT 12',
      [clientId],
      'all'
    );

    success(res, reports);
  } catch (err) {
    logger.error('[api] reports error:', err);
    next(err);
  }
});

// GET /reports/:clientId/insights — on-demand AI business intelligence report
router.get('/reports/:clientId/insights', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    // Return cached result if fresh (prevents repeat Anthropic calls)
    const cacheKey = `insights:${clientId}:${days}`;
    const cached = insightsCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < INSIGHTS_CACHE_TTL) {
      return success(res, cached.data);
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all metrics in parallel
    const [client, calls, messages, leads, bookings, revenue, topLeads, stageBreakdown, hourlyActivity] = await Promise.all([
      db.query('SELECT * FROM clients WHERE id = ?', [clientId], 'get'),
      db.query(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
          SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed,
          AVG(duration) as avg_duration_sec
        FROM calls WHERE client_id = ? AND created_at >= ?`,
        [clientId, since], 'get'
      ),
      db.query(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
          SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound
        FROM messages WHERE client_id = ? AND created_at >= ?`,
        [clientId, since], 'get'
      ),
      db.query(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN stage = 'new' THEN 1 ELSE 0 END) as new_leads,
          SUM(CASE WHEN stage IN ('contacted','warm','hot') THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN stage = 'lost' THEN 1 ELSE 0 END) as lost,
          AVG(score) as avg_score
        FROM leads WHERE client_id = ? AND created_at >= ?`,
        [clientId, since], 'get'
      ),
      db.query(
        `SELECT COUNT(*) as total FROM appointments WHERE client_id = ? AND status = 'confirmed' AND created_at >= ?`,
        [clientId, since], 'get'
      ),
      db.query(
        `SELECT COALESCE(SUM(revenue_closed), 0) as closed, COALESCE(SUM(job_value), 0) as pipeline
        FROM leads WHERE client_id = ? AND updated_at >= ?`,
        [clientId, since], 'get'
      ),
      db.query(
        `SELECT name, phone, score, stage, source FROM leads
        WHERE client_id = ? AND score >= 65 ORDER BY score DESC LIMIT 5`,
        [clientId], 'all'
      ),
      db.query(
        `SELECT stage, COUNT(*) as count FROM leads WHERE client_id = ? GROUP BY stage`,
        [clientId], 'all'
      ),
      db.query(
        `SELECT strftime('%H', created_at) as hour, COUNT(*) as count
        FROM calls WHERE client_id = ? AND created_at >= ?
        GROUP BY hour ORDER BY count DESC LIMIT 3`,
        [clientId, since], 'all'
      ),
    ]);

    if (!client) {
      return next(new AppError('NOT_FOUND', 'Client not found', 404));
    }

    const bookingRate = calls.total > 0 ? Math.round(((calls.booked || 0) / calls.total) * 100) : 0;
    const missedRate = calls.total > 0 ? Math.round(((calls.missed || 0) / calls.total) * 100) : 0;

    const stats = {
      period_days: days,
      calls: {
        total: calls.total || 0,
        booked: calls.booked || 0,
        missed: calls.missed || 0,
        avg_duration_sec: Math.round(calls.avg_duration_sec || 0),
        booking_rate_pct: bookingRate,
        missed_rate_pct: missedRate,
      },
      messages: {
        total: messages.total || 0,
        inbound: messages.inbound || 0,
        outbound: messages.outbound || 0,
      },
      leads: {
        total: leads.total || 0,
        new: leads.new_leads || 0,
        active: leads.active || 0,
        lost: leads.lost || 0,
        avg_score: Math.round(leads.avg_score || 0),
      },
      appointments: { confirmed: bookings.total || 0 },
      revenue: {
        closed: revenue.closed || 0,
        pipeline: revenue.pipeline || 0,
        estimated_from_bookings: (calls.booked || 0) * (client.avg_ticket || 0),
      },
      stage_breakdown: stageBreakdown,
      peak_hours: hourlyActivity.map(h => `${h.hour}:00 (${h.count} calls)`),
      hot_leads: topLeads,
    };

    // Generate AI narrative via circuit breaker — graceful fallback to null
    let ai_narrative = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const prompt = `You are an AI business analyst. Analyze these ${days}-day metrics for ${client.business_name || client.name} (${client.industry || 'service business'}) and write a 5-point bullet-point report.

Metrics:
- Calls: ${stats.calls.total} total, ${stats.calls.booking_rate_pct}% booked, ${stats.calls.missed_rate_pct}% missed
- Messages: ${stats.messages.total} total (${stats.messages.inbound} inbound)
- Leads: ${stats.leads.total} new, avg score ${stats.leads.avg_score}/100, ${stats.leads.lost} lost
- Appointments confirmed: ${stats.appointments.confirmed}
- Revenue closed: $${stats.revenue.closed.toFixed(0)}
- Peak call hours: ${stats.peak_hours.join(', ') || 'not enough data'}
- Hot leads right now: ${topLeads.length} leads with score 65+

Write exactly 5 bullets. Each bullet = one actionable insight or observation. No headers, no preamble. Start directly with "•".`;

        const response = await anthropicBreaker.call(prompt, process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514');
        ai_narrative = response?.content?.[0]?.text?.trim() || null;
      } catch (aiErr) {
        logger.warn('[reports] AI narrative generation failed:', aiErr.message);
      }
    }

    const result = {
      client_id: clientId,
      business_name: client.business_name || client.name,
      generated_at: new Date().toISOString(),
      stats,
      ai_narrative,
    };

    // Cache for 5 minutes
    insightsCache.set(cacheKey, { data: result, ts: Date.now() });

    success(res, result);
  } catch (err) {
    logger.error('[api] reports/insights error:', err);
    next(err);
  }
});

module.exports = router;
