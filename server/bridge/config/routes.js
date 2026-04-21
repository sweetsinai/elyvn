/**
 * Route Mounting
 * Mounts all route modules, rate limiters, auth, health, static files, error handlers.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { logger } = require('../utils/logger');
const { logAudit } = require('../utils/auditLog');
const { BoundedRateLimiter } = require('../utils/rateLimiter');
const { enforceClientIsolation } = require('../utils/clientIsolation');
const { RATE_LIMIT_CLEANUP_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } = require('./timing');
const {
  publicWebhookLimit,
  cleanupAllLimiters,
} = require('../middleware/rateLimits');

// --- Rate limiters ---
const generalLimiter = new BoundedRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_MAX_REQUESTS, maxEntries: 10000 });
const authLimiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 10, maxEntries: 10000 });

function createRateLimiterMiddleware(limiter) {
  return (req, res, next) => {
    const key = req.clientId || req.ip || req.connection?.remoteAddress || 'unknown';
    const result = limiter.check(key);

    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter || 60));
      try {
        const { logAudit: logRateLimit } = require('../utils/auditLog');
        if (req.app?.locals?.db) {
          logRateLimit(req.app.locals.db, { action: 'rate_limited', ip: req.ip, details: { path: req.path, method: req.method } });
        }
      } catch (_) {}
      const requestId = req.id || req.headers['x-request-id'] || 'unknown';
      return res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests', requestId });
    }
    next();
  };
}

const generalRateLimiter = createRateLimiterMiddleware(generalLimiter);
const authRateLimiter = createRateLimiterMiddleware(authLimiter);

// Per-API-key rate limit tracking
const apiKeyUsage = new Map();
const API_KEY_USAGE_MAX = 10000;
const API_KEY_USAGE_WINDOW_MS = 60 * 1000;

// Periodic cleanup: evict entries older than the rate limit window (every 60s)
const apiKeyUsageCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, usage] of apiKeyUsage) {
    if (now - usage.windowStart > API_KEY_USAGE_WINDOW_MS) {
      apiKeyUsage.delete(key);
    }
  }
  // Hard cap: if still too large after expiry sweep, clear everything (rate limits reset)
  if (apiKeyUsage.size > API_KEY_USAGE_MAX) {
    apiKeyUsage.clear();
  }
}, 60 * 1000);
// Allow process to exit even if this timer is pending
if (apiKeyUsageCleanupInterval.unref) apiKeyUsageCleanupInterval.unref();

// Timing-safe API key comparison
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- API auth middleware ---
const API_KEY = process.env.ELYVN_API_KEY;

async function apiAuth(req, res, next) {
  const db = req.app.locals.db;

  // Check JWT Bearer token first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { verifyToken } = require('../routes/auth');
      const payload = verifyToken(authHeader.slice(7));
      if (payload) {
        req.clientId = payload.clientId;
        req.email = payload.email;
        req.isJwtAuth = true;
        return next();
      }
    } catch (err) {
      logger.error('[auth] JWT verification error:', err.message);
    }
  }

  const provided = req.headers['x-api-key'];
  if (!provided) {
    logAudit(db, { action: 'auth_failure', ip: req.ip, userAgent: req.get('user-agent'), details: { reason: 'no_api_key', path: req.path } });
    return res.status(401).json({ error: 'API key required' });
  }

  // Check global admin key first
  if (API_KEY && safeCompare(provided, API_KEY)) {
    req.isAdmin = true;
    return next();
  }

  // Check per-client keys
  if (db) {
    try {
      const hash = crypto.createHash('sha256').update(provided).digest('hex');
      const keyRecord = await db.query(
        "SELECT * FROM client_api_keys WHERE api_key_hash = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > ?)",
        [hash, new Date().toISOString()],
        'get'
      );
      if (keyRecord) {
        req.clientId = keyRecord.client_id;
        try {
          req.keyPermissions = JSON.parse(keyRecord.permissions || '["read","write"]');
        } catch (parseErr) {
          logger.error('[auth] Failed to parse permissions for key:', keyRecord.id, parseErr.message);
          req.keyPermissions = ['read', 'write'];
        }
        await db.query("UPDATE client_api_keys SET last_used_at = ? WHERE id = ?", [new Date().toISOString(), keyRecord.id], 'run');
        logAudit(db, { action: 'auth_success', clientId: keyRecord.client_id, ip: req.ip, userAgent: req.get('user-agent'), details: { key_id: keyRecord.id, path: req.path } });

        // Enforce per-key rate limit
        const keyId = keyRecord.id;
        const now = Date.now();
        const WINDOW_MS = 60 * 1000;
        const limit = keyRecord.rate_limit || 60;
        const usage = apiKeyUsage.get(keyId) || { count: 0, windowStart: now };
        if (now - usage.windowStart > WINDOW_MS) {
          usage.count = 1;
          usage.windowStart = now;
        } else {
          usage.count++;
        }
        apiKeyUsage.set(keyId, usage);
        if (usage.count > limit) {
          logger.warn(`[auth] Per-key rate limit exceeded for key ${keyId} (client ${keyRecord.client_id})`);
          const requestId = req.id || req.headers['x-request-id'] || 'unknown';
          return res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests', requestId });
        }

        return next();
      }
    } catch (err) {
      logger.error('[auth] Client key lookup error:', err.message);
    }
  }

  logAudit(db, { action: 'auth_failure', ip: req.ip, userAgent: req.get('user-agent'), details: { reason: 'invalid_key', path: req.path } });
  return res.status(401).json({ error: 'Invalid API key' });
}

/**
 * Mount all routes on the Express app.
 * @param {import('express').Application} app
 * @returns {{ rateLimiterInterval: NodeJS.Timer }} cleanup handles
 */
function mountRoutes(app) {
  // db is resolved lazily at request time — NOT captured at mount time.
  // initializeDatabase() is async and may not have completed when mountRoutes() is called.
  const getDb = () => app.locals.db;

  // Apply general rate limiter to all routes
  app.use(generalRateLimiter);

  // Periodic rate limiter cleanup
  const rateLimiterInterval = setInterval(() => {
    generalLimiter.cleanup();
    authLimiter.cleanup();
    cleanupAllLimiters();
  }, RATE_LIMIT_CLEANUP_MS);

  // --- Health check endpoint (no auth required, before apiAuth) ---
  app.get('/health', async (req, res) => {
    const { getDatabaseHealth } = require('../utils/dbAdapter');
    let dbOk = false;
    let dbCounts = {};
    let dbHealth = { status: 'disconnected' };

    const db = getDb();
    try {
      await db.query('SELECT 1', [], 'get');
      dbOk = true;
      dbHealth = getDatabaseHealth(db);
      const [clients, calls, leads, messages, followups, pending_jobs] = await Promise.all([
        db.query('SELECT COUNT(*) as c FROM clients', [], 'get'),
        db.query('SELECT COUNT(*) as c FROM calls', [], 'get'),
        db.query('SELECT COUNT(*) as c FROM leads', [], 'get'),
        db.query('SELECT COUNT(*) as c FROM messages', [], 'get'),
        db.query('SELECT COUNT(*) as c FROM followups', [], 'get'),
        db.query('SELECT COUNT(*) as c FROM job_queue WHERE status = ?', ['pending'], 'get'),
      ]);
      dbCounts = {
        clients: clients.c,
        calls: calls.c,
        leads: leads.c,
        messages: messages.c,
        followups: followups.c,
        pending_jobs: pending_jobs.c,
      };
    } catch (err) {
      logger.error('[server] Failed to load database counts:', err.message);
    }

    const mem = process.memoryUsage();

    const envVars = {
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      RETELL_API_KEY: !!process.env.RETELL_API_KEY,
      TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
      TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
      CALCOM_API_KEY: !!process.env.CALCOM_API_KEY,
      ELYVN_API_KEY: !!process.env.ELYVN_API_KEY,
    };

    const apiKey = req.headers['x-api-key'];
    const isValidKey = apiKey && process.env.ELYVN_API_KEY && safeCompare(apiKey, process.env.ELYVN_API_KEY);
    const isAuthenticated = req.isAdmin || req.isJwtAuth || isValidKey;
    if (process.env.NODE_ENV === 'production' && !isAuthenticated) {
      return res.status(dbOk ? 200 : 503).json({
        status: dbOk ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
      });
    }

    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      uptime_seconds: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      memory: {
        rss_mb: Math.round(mem.rss / 1048576),
        heap_used_mb: Math.round(mem.heapUsed / 1048576),
        heap_total_mb: Math.round(mem.heapTotal / 1048576),
      },
      services: { 
        db: dbOk,
        mcp: !!process.env.ANTHROPIC_API_KEY
      },
      database: dbHealth,
      db_counts: dbCounts,
      env_configured: envVars,
    });
  });

  // Kubernetes health probes
  const healthRouter = require('../routes/api/health');
  app.use('/', healthRouter);

  // --- Route modules ---
  const retellRouter = require('../routes/retell');
  const apiRouter = require('../routes/api');
  const outreachRouter = require('../routes/outreach');
  const onboardRouter = require('../routes/onboard');
  const provisionRouter = require('../routes/provision');
  const trackingRouter = require('../routes/tracking');
  const twilioRouter = require('../routes/twilio');
  const telnyxRouter = require('../routes/telnyx');
  const authRouter = require('../routes/auth');
  const billingRouter = require('../routes/billing');
  const telegramRoutes = require('../routes/telegram');
  const formRoutes = require('../routes/forms');
  const calcomWebhook = require('../routes/calcom-webhook');
  const whatsappRouter = require('../routes/whatsapp');
  const socialRouter = require('../routes/social');
  const resellerRouter = require('../routes/api/reseller');
  const calculatorRouter = require('../routes/api/calculator');

  // Public webhooks — 300/min per IP (Retell, Twilio, Telnyx are high-volume but controlled sources)
  app.use('/webhooks/twilio', publicWebhookLimit, twilioRouter);
  app.use('/webhooks/telnyx', publicWebhookLimit, telnyxRouter);
  app.use('/webhooks/retell', publicWebhookLimit, retellRouter);
  app.use('/retell-webhook', publicWebhookLimit, retellRouter);
  app.use('/webhooks/whatsapp', publicWebhookLimit, whatsappRouter);
  app.use('/webhooks/social', publicWebhookLimit, socialRouter);

  // Public endpoints (no auth) — ROI calculator for landing page
  app.use('/api/calculator', generalRateLimiter, calculatorRouter);

  // Reseller routes — own auth system (10/min per IP)
  app.use('/v1/api/reseller', authRateLimiter, resellerRouter);
  app.use('/api/reseller', authRateLimiter, resellerRouter);

  // Auth routes (no auth required — signup/login) — 10/min per IP
  app.use('/v1/auth', authRateLimiter, authRouter);
  app.use('/v2/auth', authRateLimiter, authRouter);
  app.use('/auth', authRateLimiter, authRouter);

  // Billing routes (webhook is public, others need JWT) — 300/min for webhook
  app.use('/billing/webhook', publicWebhookLimit, billingRouter);
  app.use('/v1/billing', billingRouter);
  app.use('/v2/billing', billingRouter);
  app.use('/billing', billingRouter);

  // Outreach routes — apiAuth (10/min) covers general protection;
  // add fine-grained limits on expensive sub-operations
  app.use('/v1/api/outreach', apiAuth, enforceClientIsolation, outreachRouter);
  app.use('/v2/api/outreach', apiAuth, enforceClientIsolation, outreachRouter);
  app.use('/api/outreach', apiAuth, enforceClientIsolation, outreachRouter);

  // Mount onboard routes — requires admin auth (creates tenants, calls Retell API)
  app.use('/v1/api', authRateLimiter, apiAuth, onboardRouter);
  app.use('/v2/api', authRateLimiter, apiAuth, onboardRouter);
  app.use('/api', authRateLimiter, apiAuth, onboardRouter);

  app.use('/v1/api/provision', authRateLimiter, apiAuth, provisionRouter);
  app.use('/v2/api/provision', authRateLimiter, apiAuth, provisionRouter);
  app.use('/api/provision', authRateLimiter, apiAuth, provisionRouter);

  // General API routes — 10/min per client (authRateLimiter)
  // Lead creation endpoints get an additional 60/min per-client limiter
  app.use('/v1/api', authRateLimiter, apiAuth, enforceClientIsolation, apiRouter);
  app.use('/v2/api', authRateLimiter, apiAuth, enforceClientIsolation, apiRouter);
  app.use('/api', authRateLimiter, apiAuth, enforceClientIsolation, apiRouter);

  // Email tracking routes (no auth required)
  app.use('/t', trackingRouter);

  // Telegram bot webhook — 300/min per IP
  app.use('/webhooks/telegram', publicWebhookLimit, telegramRoutes);

  // Form webhook — 300/min per IP (inline formRateLimit also enforces per-IP)
  app.use('/webhooks/form', publicWebhookLimit, formRoutes);

  // Cal.com webhook — 300/min per IP
  app.use('/webhooks/calcom', publicWebhookLimit, calcomWebhook);

  // --- API Documentation ---
  // /api/docs (JSON spec) and /api/docs/ui (Swagger UI, dev only)
  // Gated behind apiAuth in production to avoid exposing attack surface map
  const docsRouter = require('../routes/docs');
  if (process.env.NODE_ENV !== 'production') {
    app.use('/v1/api', docsRouter);
    app.use('/v2/api', docsRouter);
    app.use('/api', docsRouter);
  } else {
    app.use('/v1/api', apiAuth, docsRouter);
    app.use('/v2/api', apiAuth, docsRouter);
    app.use('/api', apiAuth, docsRouter);
  }

  // Legacy YAML file endpoint — auth-gated in production
  app.get('/docs/openapi.yaml', (req, res, next) => {
    if (process.env.NODE_ENV === 'production' && !req.isAdmin && !req.isJwtAuth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.sendFile(path.join(__dirname, '..', 'docs', 'openapi.yaml'));
  });

  app.get('/docs', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ELYVN API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/docs/openapi.yaml', dom_id: '#swagger-ui', deepLinking: true });
  </script>
</body>
</html>`);
  });

  // Static files (production dashboard build)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Landing page route
  app.get('/landing', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
  });

  // Demo endpoint
  app.get('/demo', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'demo.html'));
  });

  // Internal JSON metrics endpoint (operational dashboard — behind apiAuth)
  app.get('/metrics/internal', apiAuth, async (req, res) => {
    try {
      const { getMetrics } = require('../utils/metrics');
      const { getConnectionCount } = require('../utils/websocket');
      const baseMetrics = getMetrics();

      let jobQueueDepth = { pending: 0, running: 0, failed: 0 };
      try {
        const db = getDb();
        const [pending, running, failed] = await Promise.all([
          db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'", [], 'get'),
          db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'processing'", [], 'get'),
          db.query("SELECT COUNT(*) as c FROM job_queue WHERE status = 'failed'", [], 'get'),
        ]);
        jobQueueDepth = { pending: pending.c, running: running.c, failed: failed.c };
      } catch (_) {}

      const { getSlidingErrorRate } = require('../utils/metrics');
      const errorRate = getSlidingErrorRate();

      res.json({
        ...baseMetrics,
        job_queue: jobQueueDepth,
        error_rate_pct: errorRate,
        active_websocket_connections: getConnectionCount(),
      });
    } catch (err) {
      logger.error('[metrics] Error:', err.message);
      res.status(500).json({ error: 'Failed to get metrics' });
    }
  });

  // Prometheus scrape endpoint — optionally protected by METRICS_API_KEY (falls back to ELYVN_API_KEY)
  // Prometheus: configure bearer_token or bearer_token_file in scrape_configs,
  // or pass ?token=<key> as a query param.
  app.get('/metrics', async (req, res) => {
    const metricsKey = process.env.METRICS_API_KEY || process.env.ELYVN_API_KEY;
    if (metricsKey) {
      const authHeader = req.headers.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const queryToken = req.query.token;
      const provided = bearerToken || queryToken;

      if (!provided) {
        res.set('WWW-Authenticate', 'Bearer realm="metrics"');
        return res.status(401).end('Unauthorized');
      }

      // Timing-safe comparison to prevent token oracle attacks
      const isValid = provided.length === metricsKey.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(metricsKey));

      if (!isValid) {
        logger.warn('[metrics] Unauthorized /metrics scrape attempt from', req.ip);
        return res.status(403).end('Forbidden');
      }
    }

    try {
      const { register } = require('../utils/prom-metrics');
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      logger.error('[metrics] Prometheus scrape error:', err.message);
      res.status(500).end('# error collecting metrics\n');
    }
  });

  // Catch-all for SPA routing
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/v1') || req.path.startsWith('/webhooks') || req.path.startsWith('/health') || req.path.startsWith('/test')) {
      return res.status(404).json({ error: 'Not found' });
    }
    const indexPath = path.join(__dirname, '..', 'public', 'index.html');
    try {
      res.sendFile(indexPath);
    } catch (err) {
      logger.error('[server] SPA index file not found:', err.message);
      res.status(404).json({ error: 'Not found' });
    }
  });

  // Error handlers
  const { errorHandler } = require('../middleware/errorHandler');
  app.use(errorHandler);

  // Global error handler (must be last)
  app.use((err, req, res, _next) => {
    if (res.headersSent) return _next(err);
    try {
      if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
        logger.warn('[server] JSON parse error:', err.message);
        return res.status(400).json({ code: 'PARSE_ERROR', message: 'Invalid JSON in request body', requestId: req.id || undefined });
      }
      if (err.message && err.message.includes('validation')) {
        logger.warn('[server] Validation error:', err.message);
        return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Request validation failed', requestId: req.id || undefined });
      }
      if (err.message && err.message.includes('database')) {
        logger.error('[server] Database error:', err.message);
        return res.status(500).json({ code: 'DATABASE_ERROR', message: 'Database error', requestId: req.id || undefined });
      }
      logger.error('[server] Unhandled error:', {
        message: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path,
      });
      const { alertCriticalError } = require('./startup');
      alertCriticalError(`${req.method} ${req.path}`, err);
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.id || undefined });
    } catch (handlerErr) {
      logger.error('[server] Error handler crashed:', handlerErr.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return { rateLimiterInterval };
}

module.exports = { mountRoutes };
