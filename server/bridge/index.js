require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

// Initialize file-based logging (must be before any console.log calls)
const { setupLogger, closeLogger } = require('./utils/logger');
setupLogger();

// Initialize monitoring & error tracking
const { initMonitoring, captureException } = require('./utils/monitoring');
initMonitoring();

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  captureException(err, { type: 'unhandledRejection' });
  console.error('[CRASH] UNHANDLED REJECTION:', reason);
});

// Catch uncaught exceptions — don't exit
process.on('uncaughtException', (error) => {
  captureException(error, { type: 'uncaughtException' });
  console.error('[CRASH] UNCAUGHT EXCEPTION:', error);
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// === STARTUP ENV VALIDATION ===
const REQUIRED_ENV = ['ANTHROPIC_API_KEY'];
const RECOMMENDED_ENV = ['RETELL_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'ELYVN_API_KEY'];
const missingRequired = REQUIRED_ENV.filter(v => !process.env[v]);
if (missingRequired.length > 0) {
  console.error(`[FATAL] Missing required env vars: ${missingRequired.join(', ')}`);
  console.error('[FATAL] Server cannot start without these. Check your .env file.');
  process.exit(1);
}
const missingRecommended = RECOMMENDED_ENV.filter(v => !process.env[v]);
if (missingRecommended.length > 0) {
  console.warn(`[WARN] Missing recommended env vars: ${missingRecommended.join(', ')} — some features will be disabled`);
}
if (!process.env.ELYVN_API_KEY) {
  console.warn('[WARN] ELYVN_API_KEY not set — API endpoints are UNPROTECTED. Set this before going live!');
}

const app = express();
const PORT = process.env.PORT || 3001;

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
    ? ['https://joyful-trust-production.up.railway.app']
    : '*');

if (!process.env.CORS_ORIGINS && process.env.NODE_ENV === 'production') {
  console.warn('[WARN] CORS_ORIGINS not set — using Railway production domain. Override with CORS_ORIGINS for custom origins.');
}

if (corsOrigins === '*') {
  console.warn('[WARN] CORS_ORIGINS not set in development — allowing all origins. Set CORS_ORIGINS for production!');
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging for errors and slow requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (res.statusCode >= 400 || ms > 5000) {
      console.log(`[REQ] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

// SQLite connection via database adapter
const { createDatabase, getDatabaseHealth } = require('./utils/dbAdapter');
let db;
try {
  db = createDatabase();
} catch (err) {
  console.error('[server] Database connection failed:', err.message);
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
      console.log(`[server] Job recovery complete: ${result.recovered} jobs recovered`);
    }
  } catch (err) {
    console.error('[server] Job recovery failed:', err.message);
    // Non-fatal error — continue startup
  }
})();

// --- Rate limiting (in-memory, per IP/client with LRU eviction) ---
const { BoundedRateLimiter } = require('./utils/rateLimiter');
const limiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 120, maxEntries: 10000 });

function rateLimiter(req, res, next) {
  const key = req.clientId || req.ip || req.connection?.remoteAddress || 'unknown';
  const result = limiter.check(key);

  res.set('X-RateLimit-Remaining', String(result.remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

  if (!result.allowed) {
    res.set('Retry-After', String(result.retryAfter || 60));
    return res.status(429).json({ error: 'Too many requests', retry_after: result.retryAfter });
  }
  next();
}

app.use(rateLimiter);

// Periodic cleanup
setInterval(() => limiter.cleanup(), 5 * 60 * 1000);

// --- API auth middleware (skip webhooks + health) ---
const API_KEY = process.env.ELYVN_API_KEY;
const { logAudit } = require('./utils/auditLog');

function apiAuth(req, res, next) {
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
        req.keyPermissions = JSON.parse(keyRecord.permissions || '["read","write"]');
        // Update last_used_at
        db.prepare("UPDATE client_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyRecord.id);
        logAudit(db, { action: 'auth_success', clientId: keyRecord.client_id, ip: req.ip, userAgent: req.get('user-agent'), details: { key_id: keyRecord.id, path: req.path } });
        return next();
      }
    } catch (err) {
      console.error('[auth] Client key lookup error:', err.message);
    }
  }

  // Dev mode fallback
  if (!API_KEY && process.env.NODE_ENV !== 'production') {
    return next();
  }

  logAudit(db, { action: 'auth_failure', ip: req.ip, userAgent: req.get('user-agent'), details: { reason: 'invalid_key', path: req.path } });
  return res.status(401).json({ error: 'Invalid API key' });
}

// Routes
const retellRouter = require('./routes/retell');
const twilioRouter = require('./routes/twilio');
const apiRouter = require('./routes/api');
const outreachRouter = require('./routes/outreach');
const onboardRouter = require('./routes/onboard');
const { enforceClientIsolation } = require('./utils/clientIsolation');

app.use('/webhooks/retell', retellRouter);
app.use('/retell-webhook', retellRouter);
app.use('/webhooks/twilio', twilioRouter);
app.use('/api/outreach', apiAuth, enforceClientIsolation, outreachRouter);
// Mount onboard routes (before general /api to allow public access)
app.use('/api', onboardRouter);
app.use('/api', apiAuth, enforceClientIsolation, apiRouter);

// Telegram bot webhook
const telegramRoutes = require('./routes/telegram');
app.use('/webhooks/telegram', telegramRoutes);

// Form webhook (any web form → speed-to-lead)
const formRoutes = require('./routes/forms');
app.use('/webhooks/form', formRoutes);

// Cal.com webhook (booking created/cancelled/rescheduled)
const calcomWebhook = require('./routes/calcom-webhook');
app.use('/webhooks/calcom', calcomWebhook);

// SSRF protection utility for redirect URLs
function isSafeRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname;
    // Block internal IPs
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return false;
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) return false;
    if (hostname === '169.254.169.254') return false; // AWS metadata
    return true;
  } catch { return false; }
}

// Email tracking routes (open pixel and click redirect)
app.get('/t/open/:emailId', (req, res) => {
  const { emailId } = req.params;

  // Validate emailId format (UUID)
  if (!emailId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emailId)) {
    // Return pixel anyway (don't expose invalid ID)
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    return res.send(pixel);
  }

  try {
    if (db) {
      db.prepare("UPDATE emails_sent SET opened_at = COALESCE(opened_at, ?), open_count = COALESCE(open_count, 0) + 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), emailId);
    }
  } catch (err) {
    console.error('[server] Email open tracking failed:', err.message);
  }
  // Return 1x1 transparent GIF
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(pixel);
});

app.get('/t/click/:emailId', (req, res) => {
  const { emailId } = req.params;
  let url = req.query.url;

  // Validate emailId format (UUID)
  if (!emailId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emailId)) {
    return res.redirect('/');
  }

  try {
    if (db) {
      db.prepare("UPDATE emails_sent SET clicked_at = COALESCE(clicked_at, ?), click_count = COALESCE(click_count, 0) + 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), emailId);
    }
  } catch (err) {
    console.error('[server] Email click tracking failed:', err.message);
  }

  if (url) {
    try {
      const decodedUrl = decodeURIComponent(url);

      // URL validation: block dangerous protocols
      if (!decodedUrl || (!decodedUrl.startsWith('https://') && !decodedUrl.startsWith('http://'))) {
        return res.status(400).send('Invalid redirect URL');
      }
      // Block dangerous protocols
      if (decodedUrl.match(/^(javascript|data|vbscript):/i)) {
        return res.status(400).send('Invalid redirect URL');
      }

      // SSRF protection: validate redirect URL is safe
      if (!isSafeRedirectUrl(decodedUrl)) {
        return res.status(400).send('Invalid redirect URL');
      }

      // For absolute URLs, do validation via URL constructor
      new URL(decodedUrl); // Throws if invalid
      return res.redirect(decodedUrl);
    } catch (err) {
      // Invalid URL format or constructor error, redirect to home
    }
  }
  res.redirect('/');
});

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
    console.error('[metrics] Error:', err.message);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Health check
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
    console.error('[server] Failed to load database counts:', err.message);
  }

  const mem = process.memoryUsage();

  const envVars = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    RETELL_API_KEY: !!process.env.RETELL_API_KEY,
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: !!process.env.TWILIO_PHONE_NUMBER,
    TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
    CALCOM_API_KEY: !!process.env.CALCOM_API_KEY,
    ELYVN_API_KEY: !!process.env.ELYVN_API_KEY,
  };

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

// Catch-all for SPA routing — exclude API/webhook/health paths
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhooks') || req.path.startsWith('/health') || req.path.startsWith('/test')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    res.sendFile(indexPath);
  } catch (err) {
    console.error('[server] SPA index file not found:', err.message);
    res.status(404).json({ error: 'Not found' });
  }
});

// Global error handler
app.use((err, req, res, _next) => {
  // JSON parse errors from body-parser
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[server] ELYVN bridge running on port ${PORT}`);

  // Graceful shutdown
  const { initGracefulShutdown } = require('./utils/gracefulShutdown');
  initGracefulShutdown(server, db);

  // Initialize WebSocket
  const { initWebSocket } = require('./utils/websocket');
  initWebSocket(server);

  // Initialize Telegram scheduler
  const { initScheduler } = require('./utils/scheduler');
  if (db) initScheduler(db);

  // Start backup scheduler
  if (db) {
    const { scheduleBackups } = require('./utils/backup');
    scheduleBackups(db._path, 24); // Daily backups
  }

  // Run data retention daily
  if (db) {
    const { runRetention } = require('./utils/dataRetention');
    setInterval(() => {
      runRetention(db);
    }, 24 * 60 * 60 * 1000); // Every 24 hours
  }

  // Start job queue processor
  if (db) {
    const { processJobs } = require('./utils/jobQueue');
    const { sendSMS } = require('./utils/sms');
    const { triggerSpeedSequence } = require('./utils/speed-to-lead');
    const { createJobHandlers } = require('./utils/jobHandlers');

    const jobHandlers = createJobHandlers(db, sendSMS, captureException);

    setInterval(() => {
      try {
        processJobs(db, jobHandlers).catch(err => {
          console.error('[jobQueue] Processing error:', err.message);
          // Log to monitoring if available
          if (captureException) {
            captureException(err, { context: 'jobQueue.processJobs' });
          }
        });
      } catch (err) {
        console.error('[jobQueue] Unexpected error in setInterval:', err.message);
        if (captureException) {
          captureException(err, { context: 'jobQueue.setInterval' });
        }
      }
    }, 15000); // Every 15 seconds
  }

  // Auto-classify replies every 5 minutes
  setInterval(async () => {
    try {
      const unclassified = db.prepare(`
        SELECT COUNT(*) as c FROM emails_sent
        WHERE reply_text IS NOT NULL AND reply_classification IS NULL
      `).get();
      if (unclassified.c > 0) {
        console.log(`[auto-classify] Found ${unclassified.c} unclassified replies, triggering...`);
        // Use internal HTTP call to reuse route logic
        const http = require('http');
        try {
          const req = http.request({
            hostname: 'localhost',
            port: PORT,
            path: '/api/outreach/auto-classify',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
            },
          }, (res) => {
            res.on('error', (err) => {
              console.error('[auto-classify] Response error:', err.message);
              if (captureException) {
                captureException(err, { context: 'auto-classify.response' });
              }
            });
            res.on('data', () => {}); // drain response
            res.on('end', () => {
              // Properly close connection
            });
          });
          req.on('error', (err) => {
            console.error('[auto-classify] Request error:', err.message);
            if (captureException) {
              captureException(err, { context: 'auto-classify.request' });
            }
          });
          req.setTimeout(30000, () => {
            req.destroy();
            console.error('[auto-classify] Request timeout after 30s');
          });
          req.end();
        } catch (reqErr) {
          console.error('[auto-classify] Request creation error:', reqErr.message);
          if (captureException) {
            captureException(reqErr, { context: 'auto-classify.creation' });
          }
        }
      }
    } catch (err) {
      console.error('[auto-classify] Periodic check error:', err.message);
      if (captureException) {
        captureException(err, { context: 'auto-classify.periodic' });
      }
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  // Set Telegram webhook on startup
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.BASE_URL || `http://localhost:${PORT}`;
    const { setWebhook } = require('./utils/telegram');
    setWebhook(`${baseUrl}/webhooks/telegram`);
  }
});

// Cleanup on logger close
// Note: Graceful shutdown is now handled by initGracefulShutdown() above

module.exports = app;
