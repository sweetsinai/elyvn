// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH] UNHANDLED REJECTION:', reason);
});

// Catch uncaught exceptions — don't exit
process.on('uncaughtException', (error) => {
  console.error('[CRASH] UNCAUGHT EXCEPTION:', error);
});

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
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

// SQLite connection
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../mcp/elyvn.db');
let db;
try {
  db = new Database(DB_PATH, { verbose: process.env.NODE_ENV === 'development' ? console.log : undefined });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Ensure indexes on frequently queried columns
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_calls_call_id ON calls(call_id);
    CREATE INDEX IF NOT EXISTS idx_calls_caller_phone ON calls(caller_phone);
    CREATE INDEX IF NOT EXISTS idx_calls_client_id ON calls(client_id);
    CREATE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_id, phone);
    CREATE INDEX IF NOT EXISTS idx_messages_client_phone ON messages(client_id, phone);
    CREATE INDEX IF NOT EXISTS idx_followups_lead_id ON followups(lead_id);
  `);

  console.log('[server] SQLite connected:', DB_PATH);
} catch (err) {
  console.error('[server] SQLite connection failed:', err.message);
}

// Make db available to routes
app.locals.db = db;

// --- Rate limiting (in-memory, per IP) ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 120; // requests per window

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

app.use(rateLimiter);

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.start < cutoff) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// --- API auth middleware (skip webhooks + health) ---
const API_KEY = process.env.ELYVN_API_KEY;

function apiAuth(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open (dev mode)
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Routes
const retellRouter = require('./routes/retell');
const twilioRouter = require('./routes/twilio');
const apiRouter = require('./routes/api');
const outreachRouter = require('./routes/outreach');

app.use('/webhooks/retell', retellRouter);
app.use('/retell-webhook', retellRouter);
app.use('/webhooks/twilio', twilioRouter);
app.use('/api/outreach', apiAuth, outreachRouter);
app.use('/api', apiAuth, apiRouter);

// Telegram bot webhook
const telegramRoutes = require('./routes/telegram');
app.use('/webhooks/telegram', telegramRoutes);

// Form webhook (any web form → speed-to-lead)
const formRoutes = require('./routes/forms');
app.use('/webhooks/form', formRoutes);

// Static files (production dashboard build)
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', async (req, res) => {
  let dbOk = false;
  let dbCounts = {};

  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
    dbCounts = {
      clients: db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
      calls: db.prepare('SELECT COUNT(*) as c FROM calls').get().c,
      leads: db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
      messages: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
      followups: db.prepare('SELECT COUNT(*) as c FROM followups').get().c,
    };
  } catch (_) {}

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
  } catch (_) {
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

app.listen(PORT, () => {
  console.log(`[server] ELYVN bridge running on port ${PORT}`);

  // Initialize Telegram scheduler
  const { initScheduler } = require('./utils/scheduler');
  if (db) initScheduler(db);

  // Set Telegram webhook on startup
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.BASE_URL || `http://localhost:${PORT}`;
    const { setWebhook } = require('./utils/telegram');
    setWebhook(`${baseUrl}/webhooks/telegram`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[server] Shutting down...');
  if (db) db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (db) db.close();
  process.exit(0);
});

module.exports = app;
