const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { success } = require('../../utils/response');

// GET /health/detailed — Detailed health with metrics (existing, kept for backward compat)
router.get('/health/detailed', (req, res) => {
  try {
    const { getMetrics } = require('../../utils/metrics');
    const metrics = getMetrics();
    success(res, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      metrics,
    });
  } catch (err) {
    logger.error('[health] /health/detailed metrics error:', err.message);
    res.status(500).json({ status: 'error', code: 'METRICS_ERROR', error: 'Failed to retrieve metrics' });
  }
});

/**
 * GET /health/live — Kubernetes liveness probe
 * Returns 200 immediately. No DB check. Only fails if the process is totally broken.
 */
router.get('/health/live', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /health/ready — Kubernetes readiness probe
 * Checks DB connectivity and that the job queue is not stalled.
 * Returns 200 when ready to serve traffic, 503 when not ready.
 */
router.get('/health/ready', async (req, res) => {
  const db = req.app.locals.db;
  const checks = { db: false, job_queue: false };
  const errors = [];

  // DB connectivity
  try {
    if (db) {
      await db.query('SELECT 1', [], 'get');
      checks.db = true;
    } else {
      errors.push('db: not initialized');
    }
  } catch (err) {
    errors.push(`db: ${err.message}`);
  }

  // Job queue not stalled: no jobs stuck in 'processing' for > 30 minutes
  try {
    if (db) {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const stalled = await db.query(
        "SELECT COUNT(*) as c FROM job_queue WHERE status = 'processing' AND updated_at < ?",
        [thirtyMinAgo],
        'get'
      );
      if (stalled.c > 0) {
        errors.push(`job_queue: ${stalled.c} stalled job(s)`);
      } else {
        checks.job_queue = true;
      }
    }
  } catch (err) {
    errors.push(`job_queue: ${err.message}`);
  }

  const ready = checks.db && checks.job_queue;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    code: ready ? 'READY' : 'NOT_READY',
    timestamp: new Date().toISOString(),
    checks,
    ...(errors.length > 0 && { errors }),
  });
});

/**
 * GET /health/startup — Kubernetes startup probe
 * Checks that DB migrations are current (latest migration has been applied).
 * Returns 200 when startup is complete, 503 when still starting.
 */
router.get('/health/startup', async (req, res) => {
  const db = req.app.locals.db;
  const checks = { db: false, migrations: false };
  const errors = [];

  try {
    if (!db) {
      errors.push('db: not initialized');
      return res.status(503).json({
        status: 'starting',
        code: 'DB_NOT_INITIALIZED',
        timestamp: new Date().toISOString(),
        checks,
        errors,
      });
    }

    await db.query('SELECT 1', [], 'get');
    checks.db = true;

    // Check migrations table exists and has at least one row
    try {
      const migRow = await db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'",
        [],
        'get'
      );

      if (!migRow) {
        errors.push('migrations: migrations table does not exist');
      } else {
        const latest = await db.query(
          "SELECT name FROM migrations ORDER BY applied_at DESC LIMIT 1",
          [],
          'get'
        );
        if (latest) {
          checks.migrations = true;
        } else {
          errors.push('migrations: no migrations have been applied');
        }
      }
    } catch (err) {
      errors.push(`migrations: ${err.message}`);
    }
  } catch (err) {
    errors.push(`db: ${err.message}`);
  }

  const started = checks.db && checks.migrations;
  res.status(started ? 200 : 503).json({
    status: started ? 'started' : 'starting',
    code: started ? 'STARTED' : 'STARTING',
    timestamp: new Date().toISOString(),
    checks,
    ...(errors.length > 0 && { errors }),
  });
});

// GET /health/version — Git SHA + build info for deployment verification
router.get('/health/version', (req, res) => {
  success(res, {
    version: process.env.npm_package_version || '1.0.0',
    git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'unknown',
    node_version: process.version,
    uptime_seconds: Math.floor(process.uptime()),
    deployed_at: process.env.RAILWAY_DEPLOY_TIMESTAMP || null,
  });
});

module.exports = router;
