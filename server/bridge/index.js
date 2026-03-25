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

// Middleware — restrict CORS to known origins
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : null; // null = allow all in dev, but warn

if (!ALLOWED_ORIGINS) {
  console.warn('[WARN] CORS_ORIGINS not set — allowing all origins. Set CORS_ORIGINS for production!');
}

app.use(cors({
  origin: ALLOWED_ORIGINS || true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
}));
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

// Clean up rate limit map every 5 minutes + cap size to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.start < cutoff) rateLimitMap.delete(ip);
  }
  // Hard cap: if map somehow grows huge, nuke it
  if (rateLimitMap.size > 10000) {
    console.warn(`[rateLimit] Map size ${rateLimitMap.size} exceeded cap, clearing`);
    rateLimitMap.clear();
  }
}, 5 * 60 * 1000);

// --- API auth middleware (skip webhooks + health) ---
const API_KEY = process.env.ELYVN_API_KEY;

function apiAuth(req, res, next) {
  // In production, API_KEY MUST be set. In dev, warn but allow through.
  if (!API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'Server misconfigured — API key not set' });
    }
    return next(); // dev mode fallback
  }
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
  } catch (_) {
    // Silently fail if email not found or DB error
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
  const url = req.query.url;

  // Validate emailId format (UUID)
  if (!emailId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emailId)) {
    return res.redirect('/');
  }

  try {
    if (db) {
      db.prepare("UPDATE emails_sent SET clicked_at = COALESCE(clicked_at, ?), click_count = COALESCE(click_count, 0) + 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), emailId);
    }
  } catch (_) {
    // Silently fail if email not found or DB error
  }

  if (url) {
    try {
      const decodedUrl = decodeURIComponent(url);
      // Only allow http/https URLs or relative paths (starting with /)
      // This prevents open redirect attacks
      if (decodedUrl.startsWith('http://') || decodedUrl.startsWith('https://') || decodedUrl.startsWith('/')) {
        // For absolute URLs, do basic validation via URL constructor
        if (decodedUrl.startsWith('http')) {
          new URL(decodedUrl); // Throws if invalid
        }
        return res.redirect(decodedUrl);
      }
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
        await sendSMS(payload.phone, payload.message, payload.from, db, payload.clientId);
      },
      'speed_to_lead_callback': async (payload) => {
        const { scheduleCallback } = require('./utils/speed-to-lead');
        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(payload.clientId);
        if (!client) {
          console.error(`[jobQueue] speed_to_lead_callback — client ${payload.clientId} not found`);
          return;
        }
        // Check if lead already booked before making the callback
        const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(payload.leadId);
        if (lead && (lead.stage === 'booked' || lead.stage === 'completed')) {
          console.log(`[jobQueue] Skipping callback — lead ${payload.leadId} already ${lead.stage}`);
          return;
        }
        scheduleCallback(db, { ...payload, client });
      },
      'followup_sms': async (payload) => {
        // Check if lead already booked before sending follow-up
        if (payload.leadId) {
          const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(payload.leadId);
          if (lead && (lead.stage === 'booked' || lead.stage === 'completed')) {
            console.log(`[jobQueue] Skipping followup_sms — lead ${payload.leadId} already ${lead.stage}`);
            return;
          }
        }
        await sendSMS(payload.phone || payload.to, payload.message || payload.body, payload.from, db, payload.clientId);
      },
      'appointment_reminder': async (payload) => {
        // Verify appointment hasn't been cancelled
        if (payload.appointmentId) {
          const appt = db.prepare('SELECT status FROM appointments WHERE id = ?').get(payload.appointmentId);
          if (appt && appt.status === 'cancelled') {
            console.log(`[jobQueue] Skipping reminder — appointment ${payload.appointmentId} cancelled`);
            return;
          }
        }
        await sendSMS(payload.phone, payload.message, payload.from, db, payload.clientId);
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
        }, (res) => {
          res.on('error', (err) => {
            console.error('[auto-classify] Response error:', err.message);
          });
          res.on('data', () => {}); // drain response
        });
        req.on('error', (err) => {
          console.error('[auto-classify] Request error:', err.message);
        });
        req.setTimeout(30000, () => {
          req.destroy();
          console.error('[auto-classify] Request timeout after 30s');
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
