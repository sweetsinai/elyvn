require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

// Initialize file-based logging (must be before any console.log calls)
const { setupLogger, closeLogger, logger } = require('./utils/logger');
setupLogger();

// Initialize monitoring & error tracking
const { initMonitoring, captureException } = require('./utils/monitoring');
initMonitoring();

// Send critical errors to Telegram (admin chat)
async function alertCriticalError(context, error) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return;
  const msg = `ELYVN Error\n\nContext: ${context}\nError: ${String(error?.message || error).slice(0, 500)}\nTime: ${new Date().toISOString()}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    });
  } catch (_) { /* alerting failure is non-fatal */ }
}

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  captureException(err, { type: 'unhandledRejection' });
  logger.error('[CRASH] UNHANDLED REJECTION:', reason);
  alertCriticalError('Unhandled Rejection', err);
});

// Catch uncaught exceptions — don't exit
process.on('uncaughtException', (error) => {
  captureException(error, { type: 'uncaughtException' });
  logger.error('[CRASH] UNCAUGHT EXCEPTION:', error);
  alertCriticalError('Uncaught Exception', error);
});

const express = require('express');
const helmet = require('helmet');
const { RATE_LIMIT_CLEANUP_MS, JOB_PROCESSOR_INTERVAL, DATA_RETENTION_DAILY_INTERVAL_MS, AUTO_CLASSIFY_INTERVAL_MS } = require('./config/timing');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { isValidUUID } = require('./utils/validate');

// === STARTUP ENV VALIDATION ===
const REQUIRED_ENV = ['ANTHROPIC_API_KEY'];
const RECOMMENDED_ENV = ['RETELL_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'ELYVN_API_KEY'];
const missingRequired = REQUIRED_ENV.filter(v => !process.env[v]);
if (missingRequired.length > 0) {
  logger.error(`[FATAL] Missing required env vars: ${missingRequired.join(', ')}`);
  logger.error('[FATAL] Server cannot start without these. Check your .env file.');
  process.exit(1);
}
const missingRecommended = RECOMMENDED_ENV.filter(v => !process.env[v]);
if (missingRecommended.length > 0) {
  logger.warn(`[WARN] Missing recommended env vars: ${missingRecommended.join(', ')} — some features will be disabled`);
}
if (!process.env.ELYVN_API_KEY) {
  logger.warn('[WARN] ELYVN_API_KEY not set — API endpoints are UNPROTECTED. Set this before going live!');
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  logger.error('[FATAL] JWT_SECRET must be at least 32 characters for security');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_SECRET_KEY) {
  logger.warn('[WARN] STRIPE_SECRET_KEY not set — billing features disabled');
}
if (process.env.NODE_ENV === 'production' && !process.env.TELEGRAM_ADMIN_CHAT_ID) {
  logger.warn('[WARN] TELEGRAM_ADMIN_CHAT_ID not set — critical error alerts to Telegram disabled');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Force HTTPS in production (Railway sets x-forwarded-proto)
if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
  app.use((req, res, next) => {
    // Skip redirect for health checks (Railway internal healthcheck has no x-forwarded-proto)
    if (req.path === '/health') return next();
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}

// Security headers via Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Required for dashboard (React)
      styleSrc: ["'self'", "'unsafe-inline'"], // Required for dashboard styles
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.anthropic.com', 'https://api.retellai.com', 'https://api.stripe.com', 'wss:'],
      frameSrc: ["'self'", 'https://checkout.stripe.com', 'https://js.stripe.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Additional security headers
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('X-Powered-By');
  next();
});

// Timing-safe API key comparison
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Middleware — restrict CORS to known origins
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : (process.env.NODE_ENV === 'production'
    ? [
        'https://joyful-trust-production.up.railway.app',
        'https://api.elyvn.net',
        'https://elyvn.net',
        'https://www.elyvn.net',
        'https://elyvn.vercel.app',
        process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null,
      ].filter(Boolean)
    : '*');

if (!process.env.CORS_ORIGINS && process.env.NODE_ENV === 'production') {
  logger.warn('[WARN] CORS_ORIGINS not set — using Railway production domain. Override with CORS_ORIGINS for custom origins.');
}

if (corsOrigins === '*') {
  logger.warn('[WARN] CORS_ORIGINS not set in development — allowing all origins. Set CORS_ORIGINS for production!');
}

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
}));

// Add correlation ID middleware early in the chain
const { correlationMiddleware } = require('./utils/correlationId');
app.use(correlationMiddleware);

// Capture raw body for webhook signature verification (Stripe, Twilio)
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// Request ID middleware — add X-Request-ID for traceability
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Request logging for all requests with method, path, status, duration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(`[REQ] ${req.id} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// SQLite connection via database adapter
const { createDatabase, getDatabaseHealth } = require('./utils/dbAdapter');
let db;
try {
  db = createDatabase();
} catch (err) {
  logger.error('[server] Database connection failed:', err.message);
  process.exit(1);
}

// Make db available to routes
app.locals.db = db;

// Recover stalled jobs from crashes
(async () => {
  try {
    const { recoverStalledJobs } = require('./utils/jobQueue');
    const result = await recoverStalledJobs(db);
    if (result.recovered > 0) {
      logger.info(`[server] Job recovery complete: ${result.recovered} jobs recovered`);
    }
  } catch (err) {
    logger.error('[server] Job recovery failed:', err.message);
    // Non-fatal error — continue startup
  }
})();

// --- Rate limiting (in-memory, per IP/client with LRU eviction) ---
const { BoundedRateLimiter } = require('./utils/rateLimiter');
// General API rate limiter: 100 requests per minute per IP
const generalLimiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 100, maxEntries: 10000 });
// Auth-related rate limiter: 10 requests per minute per IP
const authLimiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 10, maxEntries: 10000 });

function createRateLimiterMiddleware(limiter) {
  return (req, res, next) => {
    const key = req.clientId || req.ip || req.connection?.remoteAddress || 'unknown';
    const result = limiter.check(key);

    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter || 60));
      // Audit log rate limit hits (lazy-load to avoid circular deps)
      try {
        const { logAudit: logRateLimit } = require('./utils/auditLog');
        if (req.app?.locals?.db) {
          logRateLimit(req.app.locals.db, { action: 'rate_limited', ip: req.ip, details: { path: req.path, method: req.method } });
        }
      } catch (_) {}
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }
    next();
  };
}

const generalRateLimiter = createRateLimiterMiddleware(generalLimiter);
const authRateLimiter = createRateLimiterMiddleware(authLimiter);
// Webhook rate limiter: 60 requests per minute per IP (prevents flooding)
const webhookLimiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 60, maxEntries: 5000 });
const webhookRateLimiter = createRateLimiterMiddleware(webhookLimiter);

// Apply general rate limiter to all routes
app.use(generalRateLimiter);

// Periodic cleanup
const rateLimiterInterval = setInterval(() => {
  generalLimiter.cleanup();
  authLimiter.cleanup();
  webhookLimiter.cleanup();
}, RATE_LIMIT_CLEANUP_MS);

// --- Health check endpoint (no auth required, before apiAuth) ---
app.get('/health', async (req, res) => {
  let dbOk = false;
  let dbCounts = {};
  let dbHealth = { status: 'disconnected' };

  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
    dbHealth = getDatabaseHealth(db);
    dbCounts = {
      clients: db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
      calls: db.prepare('SELECT COUNT(*) as c FROM calls').get().c,
      leads: db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
      messages: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
      followups: db.prepare('SELECT COUNT(*) as c FROM followups').get().c,
      pending_jobs: db.prepare('SELECT COUNT(*) as c FROM job_queue WHERE status = ?').get('pending').c,
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

  // In production, only expose minimal health info to public
  if (process.env.NODE_ENV === 'production' && !req.headers['x-api-key']) {
    return res.json({
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
    });
  }

  res.json({
    status: dbOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1048576),
      heap_used_mb: Math.round(mem.heapUsed / 1048576),
      heap_total_mb: Math.round(mem.heapTotal / 1048576),
    },
    services: { db: dbOk },
    database: dbHealth,
    db_counts: dbCounts,
    env_configured: envVars,
  });
});

// --- API auth middleware (skip webhooks + health) ---
const API_KEY = process.env.ELYVN_API_KEY;
const { logAudit } = require('./utils/auditLog');

function apiAuth(req, res, next) {
  // Check JWT Bearer token first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { verifyToken } = require('./routes/auth');
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
      const keyRecord = db.prepare(
        "SELECT * FROM client_api_keys WHERE api_key_hash = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))"
      ).get(hash);
      if (keyRecord) {
        req.clientId = keyRecord.client_id;
        try {
          req.keyPermissions = JSON.parse(keyRecord.permissions || '["read","write"]');
        } catch (parseErr) {
          logger.error('[auth] Failed to parse permissions for key:', keyRecord.id, parseErr.message);
          req.keyPermissions = ['read', 'write'];
        }
        // Update last_used_at
        db.prepare("UPDATE client_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyRecord.id);
        logAudit(db, { action: 'auth_success', clientId: keyRecord.client_id, ip: req.ip, userAgent: req.get('user-agent'), details: { key_id: keyRecord.id, path: req.path } });
        return next();
      }
    } catch (err) {
      logger.error('[auth] Client key lookup error:', err.message);
    }
  }

  // No dev mode bypass — always require auth

  logAudit(db, { action: 'auth_failure', ip: req.ip, userAgent: req.get('user-agent'), details: { reason: 'invalid_key', path: req.path } });
  return res.status(401).json({ error: 'Invalid API key' });
}

// Routes
const retellRouter = require('./routes/retell');
const apiRouter = require('./routes/api');
const outreachRouter = require('./routes/outreach');
const onboardRouter = require('./routes/onboard');
const provisionRouter = require('./routes/provision');
const trackingRouter = require('./routes/tracking');
const { enforceClientIsolation } = require('./utils/clientIsolation');

// Twilio inbound SMS webhook
const twilioRouter = require('./routes/twilio');
app.use('/webhooks/twilio', webhookRateLimiter, twilioRouter);

app.use('/webhooks/retell', webhookRateLimiter, retellRouter);
app.use('/retell-webhook', webhookRateLimiter, retellRouter);

// Auth routes (no auth required — signup/login)
const authRouter = require('./routes/auth');
app.use('/auth', authRateLimiter, authRouter);

// Billing routes (webhook is public, others need JWT)
const billingRouter = require('./routes/billing');
app.use('/billing/webhook', webhookRateLimiter, billingRouter);
app.use('/billing', billingRouter);

app.use('/api/outreach', apiAuth, enforceClientIsolation, outreachRouter);
// Mount onboard routes (before general /api to allow public access)
app.use('/api', onboardRouter);
app.use('/api/provision', authRateLimiter, apiAuth, provisionRouter);
app.use('/api', authRateLimiter, apiAuth, enforceClientIsolation, apiRouter);

// Email tracking routes (no auth required)
app.use('/t', trackingRouter);

// Telegram bot webhook
const telegramRoutes = require('./routes/telegram');
app.use('/webhooks/telegram', webhookRateLimiter, telegramRoutes);

// Form webhook (any web form → speed-to-lead)
const formRoutes = require('./routes/forms');
app.use('/webhooks/form', webhookRateLimiter, formRoutes);

// Cal.com webhook (booking created/cancelled/rescheduled)
const calcomWebhook = require('./routes/calcom-webhook');
app.use('/webhooks/calcom', webhookRateLimiter, calcomWebhook);

// Static files (production dashboard build)
app.use(express.static(path.join(__dirname, 'public')));

// Landing page route
app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Demo endpoint
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

// Metrics endpoint (internal, behind API auth)
app.get('/metrics', apiAuth, (req, res) => {
  try {
    const { getMetrics } = require('./utils/metrics');
    const metrics = getMetrics();
    res.json(metrics);
  } catch (err) {
    logger.error('[metrics] Error:', err.message);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Catch-all for SPA routing — exclude API/webhook/health paths
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhooks') || req.path.startsWith('/health') || req.path.startsWith('/test')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    res.sendFile(indexPath);
  } catch (err) {
    logger.error('[server] SPA index file not found:', err.message);
    res.status(404).json({ error: 'Not found' });
  }
});

// Global error handler — catch-all for unhandled errors (must be last middleware)
app.use((err, req, res, _next) => {
  try {
    // JSON parse errors from body-parser
    if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
      logger.warn('[server] JSON parse error:', err.message);
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }

    // Validation errors
    if (err.message && err.message.includes('validation')) {
      logger.warn('[server] Validation error:', err.message);
      return res.status(400).json({ error: 'Request validation failed' });
    }

    // Database errors
    if (err.message && err.message.includes('database')) {
      logger.error('[server] Database error:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    // Default: log and return generic error
    logger.error('[server] Unhandled error:', {
      message: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
    });

    // Alert on 500s via Telegram
    alertCriticalError(`${req.method} ${req.path}`, err);

    // Don't expose error details to client
    res.status(500).json({ error: 'Internal server error' });
  } catch (handlerErr) {
    logger.error('[server] Error handler crashed:', handlerErr.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const server = app.listen(PORT, () => {
  logger.info(`[server] ELYVN bridge running on port ${PORT}`);

  // Graceful shutdown
  const { initGracefulShutdown } = require('./utils/gracefulShutdown');
  initGracefulShutdown(server, db);

  // Initialize WebSocket
  const { initWebSocket } = require('./utils/websocket');
  initWebSocket(server, db);

  // Initialize Telegram scheduler
  const { initScheduler } = require('./utils/scheduler');
  if (db) initScheduler(db);

  // Start backup scheduler
  if (db) {
    const { scheduleBackups } = require('./utils/backup');
    scheduleBackups(db._path, 24, db); // Daily backups with WAL checkpoint
  }

  // Run data retention daily
  let dataRetentionInterval;
  if (db) {
    const { runRetention } = require('./utils/dataRetention');
    dataRetentionInterval = setInterval(() => {
      runRetention(db);
    }, DATA_RETENTION_DAILY_INTERVAL_MS); // Every 24 hours
  }

  // Start job queue processor
  let jobProcessorInterval;
  if (db) {
    const { processJobs } = require('./utils/jobQueue');
    const { sendSMS } = require('./utils/sms');
    const { triggerSpeedSequence } = require('./utils/speed-to-lead');
    const { createJobHandlers } = require('./utils/jobHandlers');

    const jobHandlers = createJobHandlers(db, sendSMS, captureException);

    jobProcessorInterval = setInterval(() => {
      try {
        processJobs(db, jobHandlers).catch(err => {
          logger.error('[jobQueue] Processing error:', err.message);
          // Log to monitoring if available
          if (captureException) {
            captureException(err, { context: 'jobQueue.processJobs' });
          }
        });
      } catch (err) {
        logger.error('[jobQueue] Unexpected error in setInterval:', err.message);
        if (captureException) {
          captureException(err, { context: 'jobQueue.setInterval' });
        }
      }
    }, JOB_PROCESSOR_INTERVAL); // Every 15 seconds
  }

  // Auto-classify replies every 5 minutes
  // Direct function call instead of HTTP self-request (fixes anti-pattern)
  const { autoClassifyReplies } = require('./utils/autoClassify');
  const autoClassifyInterval = setInterval(async () => {
    try {
      const unclassified = db.prepare(`
        SELECT COUNT(*) as c FROM emails_sent
        WHERE reply_text IS NOT NULL AND reply_classification IS NULL
      `).get();
      if (unclassified.c > 0) {
        logger.info(`[auto-classify] Found ${unclassified.c} unclassified replies, triggering...`);
        try {
          const result = await autoClassifyReplies(db);
          logger.info(`[auto-classify] Completed: ${result.classified} classified`);
        } catch (err) {
          logger.error('[auto-classify] Processing error:', err.message);
          if (captureException) {
            captureException(err, { context: 'auto-classify.processing' });
          }
        }
      }
    } catch (err) {
      logger.error('[auto-classify] Periodic check error:', err.message);
      if (captureException) {
        captureException(err, { context: 'auto-classify.periodic' });
      }
    }
  }, AUTO_CLASSIFY_INTERVAL_MS); // Every 5 minutes

  // Register timers for graceful shutdown
  const { onShutdown } = require('./utils/gracefulShutdown');
  onShutdown(async () => {
    if (rateLimiterInterval) clearInterval(rateLimiterInterval);
    if (dataRetentionInterval) clearInterval(dataRetentionInterval);
    if (jobProcessorInterval) clearInterval(jobProcessorInterval);
    if (autoClassifyInterval) clearInterval(autoClassifyInterval);
    try {
      const { stopScheduler } = require('./utils/scheduler');
      stopScheduler();
    } catch (err) {
      logger.error('[shutdown] Error stopping scheduler:', err.message);
    }
    try {
      const { cleanupFormTimers } = require('./routes/forms');
      cleanupFormTimers();
    } catch (err) {
      logger.error('[shutdown] Error cleaning up form timers:', err.message);
    }
    try {
      const { cleanupSMSTimers } = require('./utils/sms');
      cleanupSMSTimers();
    } catch (err) {
      logger.error('[shutdown] Error cleaning up SMS timers:', err.message);
    }
  });

  // Set Telegram webhook on startup
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.BASE_URL || `http://localhost:${PORT}`;
    const { setWebhook } = require('./utils/telegram');
    setWebhook(`${baseUrl}/webhooks/telegram`).catch(err =>
      logger.error('[startup] Telegram setWebhook failed (non-fatal):', err.message)
    );
  }
});

// Cleanup on logger close
// Note: Graceful shutdown is now handled by initGracefulShutdown() above

module.exports = app;
