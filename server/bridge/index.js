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

// SQLite connection
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../mcp/elyvn.db');
let db;
try {
  db = new Database(DB_PATH, { verbose: process.env.NODE_ENV === 'development' ? console.log : undefined });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log('[server] SQLite connected:', DB_PATH);
} catch (err) {
  console.error('[server] SQLite connection failed:', err.message);
}

// Make db available to routes
app.locals.db = db;

// Routes
const retellRouter = require('./routes/retell');
const twilioRouter = require('./routes/twilio');
const apiRouter = require('./routes/api');
const outreachRouter = require('./routes/outreach');

app.use('/webhooks/retell', retellRouter);
app.use('/retell-webhook', retellRouter);
app.use('/webhooks/twilio', twilioRouter);
app.use('/api/outreach', outreachRouter);
app.use('/api', apiRouter);

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
  let mcpOk = false;
  let dbOk = false;

  try {
    const resp = await fetch('http://localhost:8000/health');
    mcpOk = resp.ok;
  } catch (_) {}

  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch (_) {}

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: { mcp: mcpOk, db: dbOk }
  });
});

// Catch-all for SPA routing
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    res.sendFile(indexPath);
  } catch (_) {
    res.status(404).json({ error: 'Not found' });
  }
});

// Global error handler
app.use((err, req, res, _next) => {
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
