/**
 * GET /api/system/stats — Admin-only system-wide metrics
 */

'use strict';

const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { checkDatabaseHealth, getMemoryStatus, getJobQueueStats } = require('../../utils/systemHealth');
const { success } = require('../../utils/response');

// GET /system/stats — admin-only
router.get('/system/stats', async (req, res, next) => {
  // Must be admin (global API key or JWT admin role)
  if (!req.isAdmin) {
    return next(new AppError('FORBIDDEN', 'Admin access required', 403));
  }

  try {
    const db = req.app.locals.db;

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const weekStr = startOfWeek.toISOString();

    const [
      totalClientsRow,
      activeClientsRow,
      totalLeadsRow,
      callsThisWeekRow,
      dbHealth,
      jobStats,
    ] = await Promise.all([
      db.query('SELECT COUNT(*) as c FROM clients', [], 'get'),
      db.query("SELECT COUNT(*) as c FROM clients WHERE is_active = 1", [], 'get'),
      db.query('SELECT COUNT(*) as c FROM leads', [], 'get'),
      db.query('SELECT COUNT(*) as c FROM calls WHERE created_at >= ?', [weekStr], 'get'),
      checkDatabaseHealth(db),
      getJobQueueStats(db),
    ]);

    // Leads by stage
    const stages = ['new', 'contacted', 'warm', 'hot', 'qualified', 'booked', 'completed', 'lost', 'nurture'];
    const leadsByStage = {};
    stages.forEach(s => { leadsByStage[s] = 0; });
    const stageRows = await db.query(
      'SELECT stage, COUNT(*) as c FROM leads GROUP BY stage',
      [], 'all'
    );
    for (const row of stageRows) {
      if (stages.includes(row.stage)) leadsByStage[row.stage] = row.c;
    }

    success(res, {
      status: 'ok',
      uptime: process.uptime(),
      clients: {
        total: totalClientsRow?.c ?? 0,
        active: activeClientsRow?.c ?? 0,
      },
      leads: {
        total: totalLeadsRow?.c ?? 0,
        byStage: leadsByStage,
      },
      calls: {
        thisWeek: callsThisWeekRow?.c ?? 0,
      },
      database: dbHealth,
      jobQueue: {
        status: jobStats.status,
        pendingJobs: jobStats.pendingJobs,
        failedJobs: jobStats.failedJobs,
        ...(jobStats.error && { error: jobStats.error }),
      },
      memory: getMemoryStatus(),
    });
  } catch (err) {
    logger.error('[system] stats error:', err);
    return next(new AppError('INTERNAL_ERROR', 'Failed to fetch system stats', 500));
  }
});

module.exports = router;
