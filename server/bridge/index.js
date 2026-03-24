require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

// Initialize file-based logging (must be before any console.log calls)
const { setupLogger, closeLogger } = require('./utils/logger');
setupLogger();

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH] UNHANDLED REJECTION:', reason);
});

// Catch uncaught exceptions — don't exit
process.on('uncaughtException', (error) => {
  console.error('[CRASH] UNCAUGHT EXCEPTION:', error);
});

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

  // Run all database migrations
  const { runMigrations } = require('./utils/migrations');
  runMigrations(db);

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
const onboardRouter = require('./routes/onboard');

app.use('/webhooks/retell', retellRouter);
app.use('/retell-webhook', retellRouter);
app.use('/webhooks/twilio', twilioRouter);
app.use('/api/outreach', apiAuth, outreachRouter);
// Mount onboard routes (before general /api to allow public access)
app.use('/api', onboardRouter);
app.use('/api', apiAuth, apiRouter);

// Telegram bot webhook
const telegramRoutes = require('./routes/telegram');
app.use('/webhooks/telegram', telegramRoutes);

// Form webhook (any web form → speed-to-lead)
const formRoutes = require('./routes/forms');
app.use('/webhooks/form', formRoutes);

// Cal.com webhook (booking created/cancelled/rescheduled)
const calcomWebhook = require('./routes/calcom-webhook');
app.use('/webhooks/calcom', calcomWebhook);

// Static files (production dashboard build)
app.use(express.static(path.join(__dirname, 'public')));

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

  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
    dbCounts = {
      clients: db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
      calls: db.prepare('SELECT COUNT(*) as c FROM calls').get().c,
      leads: db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
      messages: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
      followups: db.prepare('SELECT COUNT(*) as c FROM followups').get().c,
      pending_jobs: db.prepare('SELECT COUNT(*) as c FROM job_queue WHERE status = ?').get('pending').c,
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

  // Start backup scheduler
  if (db) {
    const { scheduleBackups } = require('./utils/backup');
    scheduleBackups(DB_PATH, 24); // Daily backups
  }

  // Start job queue processor
  if (db) {
    const { processJobs } = require('./utils/jobQueue');
    const { sendSMS } = require('./utils/sms');
    const { triggerSpeedSequence } = require('./utils/speed-to-lead');

    const jobHandlers = {
      'speed_to_lead_sms': async (payload) => {
        await sendSMS(payload.phone, payload.message, payload.from);
      },
      'speed_to_lead_callback': async (payload) => {
        const { scheduleCallback } = require('./utils/speed-to-lead');
        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(payload.clientId);
        scheduleCallback(db, { ...payload, client });
      },
      'followup_sms': async (payload) => {
        await sendSMS(payload.phone || payload.to, payload.message || payload.body, payload.from);
      },
      'appointment_reminder': async (payload) => {
        await sendSMS(payload.phone, payload.message, payload.from);
      },
      'interested_followup_email': async (payload) => {
        // 24h follow-up for INTERESTED prospects who haven't booked yet
        const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(payload.prospect_id);
        if (!prospect || prospect.status === 'booked') {
          console.log(`[jobQueue] Skipping follow-up — prospect ${payload.prospect_id} already booked or gone`);
          return;
        }
        // Check if they booked an appointment since we enqueued
        const hasBooking = db.prepare(
          "SELECT 1 FROM appointments WHERE phone = ? OR lead_id = ? LIMIT 1"
        ).get(prospect.phone, payload.prospect_id);
        if (hasBooking) {
          console.log(`[jobQueue] Skipping follow-up — prospect ${payload.prospect_id} has a booking`);
          return;
        }
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || '587'),
          secure: process.env.SMTP_SECURE === 'true',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        const BOOKING_LINK = payload.booking_link || process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo';
        const SENDER = payload.sender_name || process.env.OUTREACH_SENDER_NAME || 'Sohan';
        const body = `Hi${prospect.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nJust following up — I know things get busy! The demo is only 10 minutes and I'll show you exactly how ELYVN handles calls for businesses like yours.\n\nHere's the link again: ${BOOKING_LINK}\n\nNo pressure at all — happy to answer any questions too.\n\n${SENDER}\nELYVN`;
        await transport.sendMail({
          from: payload.from_email,
          to: payload.to_email,
          subject: `Re: ${payload.subject}`,
          text: body,
          html: body.replace(/\n/g, '<br>'),
        });
        console.log(`[jobQueue] Sent 24h interested follow-up to ${payload.to_email}`);
      },
      'noreply_followup': async (payload) => {
        // Follow-up for prospects who never replied (Day 3 or Day 7)
        const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(payload.prospect_id);
        if (!prospect || ['bounced', 'unsubscribed', 'booked', 'interested'].includes(prospect.status)) {
          console.log(`[jobQueue] Skipping no-reply follow-up — prospect ${payload.prospect_id} status: ${prospect?.status}`);
          return;
        }
        // Check if they replied since we enqueued
        const hasReply = db.prepare(
          "SELECT 1 FROM emails_sent WHERE prospect_id = ? AND reply_text IS NOT NULL LIMIT 1"
        ).get(payload.prospect_id);
        if (hasReply) {
          console.log(`[jobQueue] Skipping no-reply follow-up — prospect replied`);
          return;
        }
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || '587'),
          secure: process.env.SMTP_SECURE === 'true',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        const BOOKING_LINK = payload.booking_link || process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo';
        const SENDER = payload.sender_name || process.env.OUTREACH_SENDER_NAME || 'Sohan';
        const dayNum = payload.day || 3;
        let body;
        if (dayNum <= 3) {
          body = `Hi${prospect.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nQuick follow-up on my earlier email. I work with ${prospect.industry || 'service'} businesses in ${prospect.city || 'your area'} and thought ELYVN could help you catch calls you might be missing.\n\nWould a 10-minute demo be worth your time? ${BOOKING_LINK}\n\n${SENDER}\nELYVN`;
        } else {
          body = `Hi${prospect.business_name ? ' ' + prospect.business_name.split(' ')[0] : ''},\n\nLast note from me — I don't want to be a pest! If now's not the right time, no worries.\n\nBut if you're curious how an AI receptionist could help ${prospect.business_name || 'your business'} handle after-hours calls and book more appointments, the link below takes 10 minutes:\n\n${BOOKING_LINK}\n\nEither way, I wish you all the best.\n\n${SENDER}\nELYVN`;
        }
        await transport.sendMail({
          from: payload.from_email,
          to: payload.to_email,
          subject: `Re: ${payload.original_subject}`,
          text: body,
          html: body.replace(/\n/g, '<br>'),
        });
        // Record in emails_sent
        const { randomUUID } = require('crypto');
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO emails_sent (id, campaign_id, prospect_id, to_email, from_email, subject, body, status, sent_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
        `).run(randomUUID(), payload.campaign_id || null, payload.prospect_id, payload.to_email, payload.from_email, `Re: ${payload.original_subject}`, body, now, now, now);
        console.log(`[jobQueue] Sent Day ${dayNum} no-reply follow-up to ${payload.to_email}`);
        // If this was Day 3, schedule Day 7
        if (dayNum <= 3) {
          const { enqueueJob } = require('./utils/jobQueue');
          enqueueJob(db, 'noreply_followup', {
            ...payload,
            day: 7,
          }, new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString());
        }
      },
    };

    setInterval(() => {
      processJobs(db, jobHandlers).catch(err =>
        console.error('[jobQueue] Processing error:', err.message)
      );
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
        const req = http.request({
          hostname: 'localhost',
          port: PORT,
          path: '/api/outreach/auto-classify',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
          },
        });
        req.end();
      }
    } catch (err) {
      console.error('[auto-classify] Periodic check error:', err.message);
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[server] Shutting down...');
  if (db) db.close();
  closeLogger();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...');
  if (db) db.close();
  closeLogger();
  process.exit(0);
});

module.exports = app;
