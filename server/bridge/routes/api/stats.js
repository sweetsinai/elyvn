const express = require('express');
const router = express.Router();
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const queryCache = require('../../utils/queryCache');
const { success } = require('../../utils/response');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

const STATS_TTL = 60 * 1000; // 60 seconds

// GET /stats/:clientId
router.get('/stats/:clientId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Validate clientId format
    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    // Return cached stats if fresh
    const cacheKey = `stats:${clientId}`;
    const cached = queryCache.get(cacheKey);
    if (cached) {
      return success(res, cached);
    }

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfLastWeek = new Date(startOfWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    const thisWeekStr = startOfWeek.toISOString();
    const lastWeekStr = startOfLastWeek.toISOString();

    // Calls, messages, bookings, and client — all independent, run in parallel
    const [
      callsThisWeekRow,
      callsLastWeekRow,
      messagesThisWeekRow,
      messagesLastWeekRow,
      bookingsThisWeekRow,
      client,
    ] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND created_at >= ?', [clientId, thisWeekStr], 'get'),
      db.query('SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND created_at >= ? AND created_at < ?', [clientId, lastWeekStr, thisWeekStr], 'get'),
      db.query('SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND created_at >= ?', [clientId, thisWeekStr], 'get'),
      db.query('SELECT COUNT(*) as count FROM messages WHERE client_id = ? AND created_at >= ? AND created_at < ?', [clientId, lastWeekStr, thisWeekStr], 'get'),
      db.query("SELECT COUNT(*) as count FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at >= ?", [clientId, thisWeekStr], 'get'),
      db.query('SELECT avg_ticket FROM clients WHERE id = ?', [clientId], 'get'),
    ]);

    const callsThisWeek = callsThisWeekRow.count;
    const callsLastWeek = callsLastWeekRow.count;
    const callsTrend = callsLastWeek > 0
      ? Math.round(((callsThisWeek - callsLastWeek) / callsLastWeek) * 100)
      : callsThisWeek > 0 ? 100 : 0;

    const messagesThisWeek = messagesThisWeekRow.count;
    const messagesLastWeek = messagesLastWeekRow.count;
    const messagesTrend = messagesLastWeek > 0
      ? Math.round(((messagesThisWeek - messagesLastWeek) / messagesLastWeek) * 100)
      : messagesThisWeek > 0 ? 100 : 0;

    const bookingsThisWeek = bookingsThisWeekRow.count;
    const avgTicket = client?.avg_ticket || 0;
    const estimatedRevenue = bookingsThisWeek * avgTicket;

    // Leads by stage — single GROUP BY query instead of N+1
    const stages = ['new', 'contacted', 'warm', 'hot', 'qualified', 'booked', 'completed', 'lost', 'nurture'];
    const leadsByStage = {};
    stages.forEach(s => { leadsByStage[s] = 0; });
    const stageRows = await db.query(
      'SELECT stage, COUNT(*) as count FROM leads WHERE client_id = ? GROUP BY stage',
      [clientId], 'all'
    );
    for (const row of stageRows) {
      if (stages.includes(row.stage)) leadsByStage[row.stage] = row.count;
    }

    const statsData = {
      calls_this_week: callsThisWeek,
      calls_last_week: callsLastWeek,
      calls_trend: callsTrend,
      messages_this_week: messagesThisWeek,
      messages_last_week: messagesLastWeek,
      messages_trend: messagesTrend,
      bookings_this_week: bookingsThisWeek,
      estimated_revenue: estimatedRevenue,
      leads_by_stage: leadsByStage
    };

    queryCache.set(cacheKey, statsData, STATS_TTL);
    success(res, statsData);
  } catch (err) {
    logger.error('[api] stats error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch stats', 500));
  }
});

// GET /stats/:clientId/timeseries — Daily time-series for the last N days
router.get('/stats/:clientId/timeseries', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    // Validate and cap days as integer to prevent SQL injection.
    // Compute cutoff as an ISO date string and pass as a parameterized value.
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [callSeries, messagesSentSeries, messagesReceivedSeries, leadsSeries, bookingsSeries] = await Promise.all([
      db.query(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM calls WHERE client_id = ? AND created_at > ?
        GROUP BY day ORDER BY day
      `, [clientId, since], 'all'),
      db.query(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM messages WHERE client_id = ? AND direction = 'outbound' AND created_at > ?
        GROUP BY day ORDER BY day
      `, [clientId, since], 'all'),
      db.query(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM messages WHERE client_id = ? AND direction = 'inbound' AND created_at > ?
        GROUP BY day ORDER BY day
      `, [clientId, since], 'all'),
      db.query(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM leads WHERE client_id = ? AND created_at > ?
        GROUP BY day ORDER BY day
      `, [clientId, since], 'all'),
      db.query(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM calls WHERE client_id = ? AND outcome = 'booked' AND created_at > ?
        GROUP BY day ORDER BY day
      `, [clientId, since], 'all'),
    ]);

    success(res, {
      period_days: days,
      series: {
        calls: callSeries,
        messages_sent: messagesSentSeries,
        messages_received: messagesReceivedSeries,
        leads: leadsSeries,
        bookings: bookingsSeries,
      },
    });
  } catch (err) {
    logger.error('[api] timeseries error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch time-series data', 500));
  }
});

// GET /stats/:clientId/experiments — List all experiments (admin-only: experiments are global)
router.get('/stats/:clientId/experiments', (req, res, next) => {
  try {
    if (!req.isAdmin) return next(new AppError('FORBIDDEN', 'Experiments are admin-only', 403));
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { listExperiments } = require('../../utils/experiments');
    const db = req.app.locals.db;
    const status = req.query.status || undefined;
    const experiments = listExperiments(db, status);
    success(res, experiments);
  } catch (err) {
    logger.error('[api] experiments list error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to list experiments', 500));
  }
});

// GET /stats/:clientId/experiments/:name/results — Experiment results (admin-only)
router.get('/stats/:clientId/experiments/:name/results', (req, res, next) => {
  try {
    if (!req.isAdmin) return next(new AppError('FORBIDDEN', 'Experiments are admin-only', 403));
    const { clientId, name } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { getExperimentResults } = require('../../utils/experiments');
    const db = req.app.locals.db;
    const results = getExperimentResults(db, name);

    if (!results) {
      return next(new AppError('NOT_FOUND', 'Experiment not found', 404));
    }

    success(res, results);
  } catch (err) {
    logger.error('[api] experiment results error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get experiment results', 500));
  }
});

// GET /stats/:clientId/activity — Aggregated event counts over N days
router.get('/stats/:clientId/activity', (req, res, next) => {
  try {
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { buildClientActivity } = require('../../utils/eventProjections');
    const db = req.app.locals.db;
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const activity = buildClientActivity(db, clientId, days);
    success(res, activity);
  } catch (err) {
    logger.error('[api] client activity error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to build client activity', 500));
  }
});

// GET /stats/:clientId/transitions — Stage transition matrix for funnel analysis
router.get('/stats/:clientId/transitions', (req, res, next) => {
  try {
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const { buildStageTransitionMatrix } = require('../../utils/eventProjections');
    const db = req.app.locals.db;
    const matrix = buildStageTransitionMatrix(db, clientId);
    success(res, matrix);
  } catch (err) {
    logger.error('[api] stage transitions error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to build stage transition matrix', 500));
  }
});

// GET /stats/:clientId/roi — Missed call proof + ROI dashboard
// Shows exactly what ELYVN caught and converted vs. what would have been missed
router.get('/stats/:clientId/roi', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const days = Math.min(parseInt(req.query.days) || 30, 365);

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID format', 400));
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [client, callStats, afterHoursCalls, missedConversions, speedToLeadStats, revenueData, reviewStats] = await Promise.all([
      db.query('SELECT avg_ticket, business_hours, created_at FROM clients WHERE id = ?', [clientId], 'get'),
      // Total calls, how many the AI answered, how many were missed
      db.query(`
        SELECT
          COUNT(*) as total_calls,
          SUM(CASE WHEN outcome != 'missed' AND outcome IS NOT NULL THEN 1 ELSE 0 END) as ai_answered,
          SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) as missed,
          SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booked,
          SUM(CASE WHEN outcome = 'voicemail' THEN 1 ELSE 0 END) as voicemail_handled,
          AVG(duration) as avg_duration
        FROM calls WHERE client_id = ? AND created_at >= ?
      `, [clientId, since], 'get'),
      // After-hours calls — calls the AI handled that no human would have
      db.query(`
        SELECT COUNT(*) as count FROM calls
        WHERE client_id = ? AND created_at >= ?
        AND (CAST(strftime('%H', created_at) AS INTEGER) < 8 OR CAST(strftime('%H', created_at) AS INTEGER) >= 18)
        AND outcome != 'missed'
      `, [clientId, since], 'get'),
      // Leads that came from missed_call/voicemail source and converted to booked
      db.query(`
        SELECT COUNT(*) as count FROM leads
        WHERE client_id = ? AND created_at >= ?
        AND source IN ('missed_call', 'voicemail')
        AND stage IN ('booked', 'completed')
      `, [clientId, since], 'get'),
      // Speed-to-lead effectiveness
      db.query(`
        SELECT COUNT(*) as total_speed_jobs,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
        FROM job_queue
        WHERE type IN ('speed_to_lead_sms', 'speed_to_lead_callback')
        AND json_extract(payload, '$.clientId') = ? AND created_at >= ?
      `, [clientId, since], 'get'),
      // Revenue from ELYVN-touched leads
      db.query(`
        SELECT
          COALESCE(SUM(revenue_closed), 0) as total_closed,
          COALESCE(SUM(job_value), 0) as total_pipeline,
          COUNT(CASE WHEN revenue_closed > 0 THEN 1 END) as paid_jobs
        FROM leads WHERE client_id = ? AND updated_at >= ?
      `, [clientId, since], 'get'),
      // Google review requests sent
      db.query(`
        SELECT COUNT(*) as sent FROM job_queue
        WHERE type = 'google_review_request' AND json_extract(payload, '$.clientId') = ? AND status = 'completed' AND created_at >= ?
      `, [clientId, since], 'get'),
    ]);

    const avgTicket = client?.avg_ticket || 0;
    const aiAnswered = callStats.ai_answered || 0;
    const totalCalls = callStats.total_calls || 0;
    const booked = callStats.booked || 0;
    const afterHours = afterHoursCalls.count || 0;
    const missedConverted = missedConversions.count || 0;

    // Calculate what would have been lost without ELYVN
    const estimatedLostCalls = afterHours + (callStats.voicemail_handled || 0);
    const estimatedLostRevenue = estimatedLostCalls * avgTicket * 0.15; // ~15% of after-hours calls would convert

    success(res, {
      period_days: days,
      proof: {
        total_calls_handled: totalCalls,
        ai_answered: aiAnswered,
        after_hours_answered: afterHours,
        voicemail_rescued: callStats.voicemail_handled || 0,
        missed_calls_converted: missedConverted,
        appointments_booked: booked,
        speed_to_lead_sent: speedToLeadStats.completed || 0,
        review_requests_sent: reviewStats.sent || 0,
      },
      revenue: {
        total_closed: revenueData.total_closed || 0,
        total_pipeline: revenueData.total_pipeline || 0,
        paid_jobs: revenueData.paid_jobs || 0,
        estimated_from_bookings: booked * avgTicket,
        estimated_saved_from_missed: estimatedLostRevenue,
      },
      without_elyvn: {
        calls_that_would_be_missed: estimatedLostCalls,
        estimated_lost_revenue: estimatedLostRevenue,
        explanation: `Without ELYVN, ${estimatedLostCalls} after-hours/voicemail calls would have gone unanswered. At ~15% conversion rate and $${avgTicket} avg ticket, that's ~$${Math.round(estimatedLostRevenue)} in likely lost revenue.`,
      },
      client_since: client?.created_at,
    });
  } catch (err) {
    logger.error('[api] roi stats error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to calculate ROI', 500));
  }
});

module.exports = router;
