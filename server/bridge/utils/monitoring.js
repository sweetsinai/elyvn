/**
 * Monitoring & Error Tracking
 * Integrates with Sentry (free tier) for error tracking and performance monitoring.
 * Falls back gracefully if SENTRY_DSN is not set.
 */

let Sentry = null;
let isInitialized = false;

function initMonitoring() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[monitoring] SENTRY_DSN not set — error tracking disabled');
    return;
  }

  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'production',
      release: process.env.npm_package_version || '1.0.0',
      tracesSampleRate: 0.1, // 10% of transactions for performance
      beforeSend(event) {
        // Scrub PII from error reports
        if (event.request?.headers) {
          delete event.request.headers['x-api-key'];
          delete event.request.headers['authorization'];
        }
        return event;
      },
    });
    isInitialized = true;
    console.log('[monitoring] Sentry initialized');
  } catch (err) {
    console.warn('[monitoring] Sentry init failed (package not installed?):', err.message);
  }
}

function captureException(err, context = {}) {
  if (isInitialized && Sentry) {
    Sentry.captureException(err, { extra: context });
  }
  // Always log locally too
  console.error(`[error] ${err.message}`, context);
}

function captureMessage(msg, level = 'info', context = {}) {
  if (isInitialized && Sentry) {
    Sentry.captureMessage(msg, { level, extra: context });
  }
}

function expressErrorHandler() {
  if (isInitialized && Sentry) {
    return Sentry.expressErrorHandler();
  }
  return (err, req, res, next) => next(err);
}

module.exports = { initMonitoring, captureException, captureMessage, expressErrorHandler };
