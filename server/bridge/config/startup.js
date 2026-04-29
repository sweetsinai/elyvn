/**
 * Server Startup & Initialization
 * Database init, migrations, scheduler, metrics, job processor, graceful shutdown.
 */

const { logger } = require('../utils/logger');
const { captureException } = require('../utils/monitoring');
const { createDatabase } = require('../utils/dbAdapter');
const { getDatabasePath, getKBRoot } = require('../utils/dbConfig');
const { migrations } = require('../utils/migrations');
const { backupDatabase } = require('../utils/backup');
const { JOB_PROCESSOR_INTERVAL, DATA_RETENTION_DAILY_INTERVAL_MS, AUTO_CLASSIFY_INTERVAL_MS } = require('./timing');

/**
 * Send critical errors to Telegram (admin chat).
 */
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
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) { /* alerting failure is non-fatal */ }
}

/**
 * Validate required/recommended environment variables. Exits on fatal missing vars.
 */
function validateEnv() {
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
    logger.warn('[WARN] ELYVN_API_KEY not set — API endpoints rely on JWT auth only. Set this for API key authentication.');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    logger.error('[FATAL] JWT_SECRET must be set and at least 32 characters for security');
    process.exit(1);
  }
  const uniqueChars = new Set(process.env.JWT_SECRET).size;
  if (uniqueChars < 10) {
    logger.error(`[FATAL] JWT_SECRET has low entropy (only ${uniqueChars} unique chars). Use a more random secret.`);
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.DODO_API_KEY) {
    logger.warn('[WARN] DODO_API_KEY not set — billing features disabled');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.TELEGRAM_ADMIN_CHAT_ID) {
    logger.warn('[WARN] TELEGRAM_ADMIN_CHAT_ID not set — critical error alerts to Telegram disabled');
  }
  if (!process.env.ENCRYPTION_KEY) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[FATAL] ENCRYPTION_KEY not set. Cannot start in production without encryption enforcement.');
      process.exit(1);
    }
    logger.warn('[WARN] ENCRYPTION_KEY not set — PII columns will not be encrypted. Set a 32-byte hex key for production security.');
  }
}

/**
 * Take a pre-migration backup if there are pending migrations and the DB file
 * already exists (i.e. not a fresh install). Only runs in production to avoid
 * unnecessary overhead in dev/test.
 *
 * @param {string} dbPath - Resolved path to the SQLite file
 */
async function preMigrationBackup(dbPath) {
  const fs = require('fs');
  if (!fs.existsSync(dbPath)) return; // Fresh install — nothing to back up
  if (process.env.NODE_ENV !== 'production') return; // Dev/test — skip

  try {
    const Database = require('better-sqlite3');
    const tmp = new Database(dbPath, { readonly: true });

    // Determine how many migrations are pending
    let appliedIds = [];
    try {
      appliedIds = tmp.prepare('SELECT id FROM _migrations').all().map(r => r.id);
    } catch {
      // _migrations table doesn't exist yet — all migrations are pending
    }
    const pendingCount = migrations.filter(m => !appliedIds.includes(m.id)).length;
    tmp.close();

    if (pendingCount === 0) return; // Already up to date — no backup needed

    logger.info(`[startup] ${pendingCount} pending migration(s) detected — taking pre-migration backup`);
    const result = await backupDatabase(dbPath);
    if (result.success) {
      logger.info(`[startup] Pre-migration backup created: ${result.backupPath}`);
    } else {
      logger.warn(`[startup] Pre-migration backup failed (non-fatal): ${result.error}`);
    }
  } catch (err) {
    logger.warn(`[startup] Pre-migration backup error (non-fatal): ${err.message}`);
  }
}

/**
 * Initialize database, cancel stale jobs, recover stalled jobs.
 * @param {import('express').Application} app
 * @returns {object} better-sqlite3 db instance
 */
async function initializeDatabase(app) {
  // Resolve DB path the same way dbAdapter does so the backup targets the right file
  const dbPath = getDatabasePath();
  await preMigrationBackup(dbPath);

  let db;
  try {
    db = createDatabase();
  } catch (err) {
    logger.error('[server] Database connection failed:', err.message);
    process.exit(1);
  }

  app.locals.db = db;

  // Ensure knowledge base directory exists
  try {
    const kbDir = getKBRoot();
    logger.info(`[startup] Knowledge base directory verified: ${kbDir}`);
  } catch (err) {
    logger.warn('[startup] Failed to verify knowledge base directory:', err.message);
  }

  // Validate schema — catch missing columns BEFORE any request hits the DB
  try {
    const { validateSchema } = require('../utils/schemaValidator');
    const { valid, missing } = validateSchema(db._db || db);
    if (!valid) {
      logger.error(`[FATAL] Schema validation failed — ${missing.length} missing column(s). Fix migrations and restart.`);
      if (process.env.NODE_ENV === 'production') {
        await alertCriticalError('Schema validation failed', new Error(`${missing.length} missing columns: ${missing.map(m => m.table + '.' + m.column).join(', ')}`));
        process.exit(1); // FATAL in production
      }
    }
  } catch (err) {
    logger.warn(`[startup] Schema validation error (non-fatal): ${err.message}`);
  }

  // Cancel all pending followup_sms jobs
  try {
    const cancelled = await db.query("UPDATE job_queue SET status = 'cancelled' WHERE status = 'pending' AND type = 'followup_sms'", [], 'run');
    if (cancelled.changes > 0) {
      logger.info(`[server] Cancelled ${cancelled.changes} pending followup_sms jobs`);
    }
  } catch (err) {
    logger.error('[server] Failed to cancel pending SMS jobs:', err.message);
  }

  // Recover stalled jobs from crashes
  (async () => {
    try {
      const { recoverStalledJobs } = require('../utils/jobQueue');
      const result = await recoverStalledJobs(db);
      if (result.recovered > 0) {
        logger.info(`[server] Job recovery complete: ${result.recovered} jobs recovered`);
      }
    } catch (err) {
      logger.error('[server] Job recovery failed:', err.message);
    }
  })();

  return db;
}

/**
 * Initialize all server services after listen (WebSocket, metrics, scheduler, jobs, graceful shutdown).
 * @param {import('express').Application} app
 * @param {import('http').Server} server
 * @param {{ rateLimiterInterval: NodeJS.Timer }} routeHandles - cleanup handles from mountRoutes
 */
function initializeServer(app, server, routeHandles) {
  // db resolved lazily — initializeDatabase() is async and may not have finished yet
  const getDb = () => app.locals.db;
  const PORT = process.env.PORT || 3001;

  // Wait for DB to be ready before initializing services that need it
  // initializeDatabase is async — poll until app.locals.db is set
  const waitForDb = () => new Promise((resolve) => {
    const check = () => {
      if (app.locals.db) return resolve(app.locals.db);
      setTimeout(check, 100);
    };
    check();
  });

  waitForDb().then((db) => {
    // Graceful shutdown
    const { initGracefulShutdown } = require('../utils/gracefulShutdown');
    initGracefulShutdown(server, db);

    // Initialize WebSocket
    const { initWebSocket } = require('../utils/websocket');
    initWebSocket(server, db);

    // Initialize metrics flush & threshold alerting
    const { initMetricsFlush } = require('../utils/metrics');
    initMetricsFlush(db);

    // Initialize Telegram scheduler
    const { initScheduler } = require('../utils/scheduler');
    initScheduler(db);

    // Start backup scheduler
    const { scheduleBackups } = require('../utils/backup');
    scheduleBackups(db._path, 24, db);

    // Start job queue processor
    const { processJobs } = require('../utils/jobQueue');
    const { sendSMS } = require('../utils/sms');
    const { createJobHandlers } = require('../utils/jobHandlers');

    const jobHandlers = createJobHandlers(db, sendSMS, captureException);

    const jobProcessorInterval = setInterval(() => {
      try {
        processJobs(db, jobHandlers).catch(err => {
          logger.error('[jobQueue] Processing error:', err.message);
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
    }, JOB_PROCESSOR_INTERVAL).unref();

    // Start outbound webhook delivery processor
    const { startProcessor: startWebhookProcessor } = require('../utils/webhookQueue');
    startWebhookProcessor();

    // Start knowledge base file watcher for Retell sync
    const { initKBWatcher } = require('../utils/kbWatcher');
    initKBWatcher(db);


    // Register timers for graceful shutdown
    const { onShutdown } = require('../utils/gracefulShutdown');
    onShutdown(async () => {
      if (routeHandles.rateLimiterInterval) clearInterval(routeHandles.rateLimiterInterval);
      clearInterval(jobProcessorInterval);
    try {
      const { stopKBWatcher } = require('../utils/kbWatcher');
      stopKBWatcher();
    } catch (err) {
      logger.error('[shutdown] Error stopping kbWatcher:', err.message);
    }
    try {
      const { stopProcessor: stopWebhookProcessor } = require('../utils/webhookQueue');
      stopWebhookProcessor();
    } catch (err) {
      logger.error('[shutdown] Error stopping webhookQueue processor:', err.message);
    }
    try {
      const { shutdownTracing } = require('../utils/tracing');
      await shutdownTracing();
    } catch (err) {
      logger.error('[shutdown] Error shutting down tracing:', err.message);
    }
    try {
      const { stopScheduler } = require('../utils/scheduler');
      stopScheduler();
    } catch (err) {
      logger.error('[shutdown] Error stopping scheduler:', err.message);
    }
    try {
      const { cleanupFormTimers } = require('../routes/forms');
      cleanupFormTimers();
    } catch (err) {
      logger.error('[shutdown] Error cleaning up form timers:', err.message);
    }
    try {
      const { cleanupSMSTimers } = require('../utils/sms');
      cleanupSMSTimers();
    } catch (err) {
      logger.error('[shutdown] Error cleaning up SMS timers:', err.message);
    }
    });

    // Set Telegram webhook
    if (process.env.TELEGRAM_BOT_TOKEN) {
      const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : process.env.BASE_URL || `http://localhost:${PORT}`;
      const { setWebhook } = require('../utils/telegram');
      setWebhook(`${baseUrl}/webhooks/telegram`).catch(err =>
        logger.error('[startup] Telegram setWebhook failed (non-fatal):', err.message)
      );
    }

    logger.info('[startup] All services initialized (db ready)');
  }); // end waitForDb().then()
}

module.exports = { alertCriticalError, validateEnv, initializeDatabase, initializeServer };
