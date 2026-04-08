const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { isValidUUID } = require('../../utils/validate');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// GET /revenue/:clientId — Revenue attribution & ROI
router.get('/revenue/:clientId', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));
    }

    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

    const { getROIMetrics } = require('../../utils/revenueAttribution');
    const metrics = getROIMetrics(db, clientId, days);
    res.json({ data: metrics });
  } catch (err) {
    logger.error('[api] revenue error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get revenue metrics', 500));
  }
});

// GET /revenue/:clientId/funnel — Conversion funnel: sent→opened→clicked→replied→booked
router.get('/revenue/:clientId/funnel', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));
    }

    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Total emails sent to prospects linked to this client's campaigns
    const sentRow = await db.query(`
      SELECT COUNT(*) AS total
      FROM emails_sent es
      JOIN campaigns c ON c.id = es.campaign_id
      WHERE es.sent_at >= ?
        AND es.status != 'draft'
    `, [since], 'get');

    // Opened
    const openedRow = await db.query(`
      SELECT COUNT(*) AS total
      FROM emails_sent es
      JOIN campaigns c ON c.id = es.campaign_id
      WHERE es.sent_at >= ?
        AND es.opened_at IS NOT NULL
    `, [since], 'get');

    // Clicked
    const clickedRow = await db.query(`
      SELECT COUNT(*) AS total
      FROM emails_sent es
      JOIN campaigns c ON c.id = es.campaign_id
      WHERE es.sent_at >= ?
        AND es.clicked_at IS NOT NULL
    `, [since], 'get');

    // Replied (has reply_text set)
    const repliedRow = await db.query(`
      SELECT COUNT(*) AS total
      FROM emails_sent es
      JOIN campaigns c ON c.id = es.campaign_id
      WHERE es.sent_at >= ?
        AND es.reply_text IS NOT NULL
        AND es.reply_text != ''
    `, [since], 'get');

    // Booked — leads that converted, linked via prospect_id on leads table
    const bookedRow = await db.query(`
      SELECT COUNT(DISTINCT l.id) AS total
      FROM leads l
      JOIN prospects p ON p.id = l.prospect_id
      JOIN campaign_prospects cp ON cp.prospect_id = p.id
      JOIN campaigns c ON c.id = cp.campaign_id
      WHERE l.client_id = ?
        AND (l.stage = 'booked' OR l.calcom_booking_id IS NOT NULL)
        AND l.created_at >= ?
    `, [clientId, since], 'get');

    const sent    = sentRow?.total    || 0;
    const opened  = openedRow?.total  || 0;
    const clicked = clickedRow?.total || 0;
    const replied = repliedRow?.total || 0;
    const booked  = bookedRow?.total  || 0;

    // Conversion rates between each stage (as percentages, rounded to 2dp)
    const pct = (num, denom) => (denom > 0 ? Math.round((num / denom) * 10000) / 100 : 0);

    res.json({
      data: {
        period_days: days,
        stages: {
          sent,
          opened,
          clicked,
          replied,
          booked,
        },
        conversion_rates: {
          sent_to_opened:   pct(opened,  sent),
          opened_to_clicked: pct(clicked, opened),
          clicked_to_replied: pct(replied, clicked),
          replied_to_booked:  pct(booked,  replied),
          overall:            pct(booked,  sent),
        },
      },
    });
  } catch (err) {
    logger.error('[api] funnel error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get conversion funnel', 500));
  }
});

// GET /revenue/:clientId/:leadId — Single lead attribution chain
router.get('/revenue/:clientId/:leadId', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId, leadId } = req.params;

    if (!isValidUUID(clientId) || !isValidUUID(leadId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID or lead ID', 400));
    }

    const { getAttribution } = require('../../utils/revenueAttribution');
    const attribution = getAttribution(db, leadId, clientId);
    res.json({ data: attribution });
  } catch (err) {
    logger.error('[api] attribution error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get lead attribution', 500));
  }
});

// GET /revenue/:clientId/channels/performance — Channel performance breakdown
router.get('/revenue/:clientId/channels/performance', (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));
    }

    const { getChannelPerformance } = require('../../utils/revenueAttribution');
    const channels = getChannelPerformance(db, clientId);
    res.json({ data: channels });
  } catch (err) {
    logger.error('[api] channel performance error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get channel performance', 500));
  }
});

// GET /revenue/:clientId/cohorts — Cohort analysis: leads grouped by creation week/month
router.get('/revenue/:clientId/cohorts', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    if (!isValidUUID(clientId)) {
      return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));
    }

    const granularity = req.query.granularity === 'month' ? 'month' : 'week';
    const limit = Math.min(24, Math.max(1, parseInt(req.query.limit) || 12));

    let cohortExpr;
    if (granularity === 'month') {
      cohortExpr = "strftime('%Y-%m', created_at)";
    } else {
      cohortExpr = "strftime('%Y-W%W', created_at)";
    }

    const cohorts = await db.query(`
      SELECT
        ${cohortExpr} as cohort,
        COUNT(*) as total,
        SUM(CASE WHEN stage IN ('interested','qualified','booked') THEN 1 ELSE 0 END) as progressed,
        SUM(CASE WHEN stage = 'booked' THEN 1 ELSE 0 END) as converted,
        AVG(
          CASE WHEN stage = 'booked' AND updated_at IS NOT NULL
            THEN (julianday(updated_at) - julianday(created_at))
            ELSE NULL
          END
        ) as avg_days_to_convert
      FROM leads
      WHERE client_id = ?
      GROUP BY cohort
      ORDER BY cohort DESC
      LIMIT ?
    `, [clientId, limit], 'all');

    const data = cohorts.map(c => ({
      cohort: c.cohort,
      total: c.total,
      progressed: c.progressed,
      converted: c.converted,
      progression_rate: c.total > 0 ? Math.round((c.progressed / c.total) * 10000) / 100 : 0,
      conversion_rate: c.total > 0 ? Math.round((c.converted / c.total) * 10000) / 100 : 0,
      avg_days_to_convert: c.avg_days_to_convert != null ? Math.round(c.avg_days_to_convert * 10) / 10 : null,
    }));

    res.json({ data: { granularity, cohorts: data } });
  } catch (err) {
    logger.error('[api] cohorts error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get cohort analysis', 500));
  }
});

module.exports = router;
