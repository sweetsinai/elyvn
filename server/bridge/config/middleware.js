/**
 * Middleware Configuration
 * Sets up all Express middleware: security, CORS, body parsing, correlation, versioning, etc.
 */

const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const express = require('express');
const { logger } = require('../utils/logger');
const { correlationMiddleware } = require('../utils/correlationId');
const { apiVersionMiddleware } = require('../middleware/apiVersion');
const { requestNormalization } = require('../middleware/requestNormalization');
const { csrfProtection } = require('../middleware/csrf');
const { requestContext } = require('../middleware/requestContext');

/**
 * Set up all middleware on the Express app.
 * @param {import('express').Application} app
 */
function setupMiddleware(app) {
  // Force HTTPS in production (Railway sets x-forwarded-proto)
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    app.use((req, res, next) => {
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
        scriptSrc: ["'self'", "https://unpkg.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
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
      maxAge: 31536000,
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

  // Request context — assigns requestId and binds it to AsyncLocalStorage so
  // every log line within the request automatically includes it.
  app.use(requestContext);

  // Response compression — reduces bandwidth for large JSON payloads (call lists, analytics)
  app.use(compression());

  // CORS — explicit allowlist; webhook paths (/webhooks/*) are excluded via their own routers
  const ALLOWED_ORIGINS = [
    'https://elyvn.ai',
    'https://app.elyvn.ai',
    'https://dashboard-nine-ebon-97.vercel.app',
    ...(process.env.DASHBOARD_URL ? [process.env.DASHBOARD_URL] : []),
    ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : []),
    process.env.NODE_ENV !== 'production' && 'http://localhost:3000',
    process.env.NODE_ENV !== 'production' && 'http://localhost:8081',
  ].filter(Boolean);

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn('[cors] Blocked origin: ' + (origin || 'null'));
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-ID', 'X-API-Key'],
  }));

  // CSRF protection (after CORS, before routes)
  app.use(csrfProtection);

  // Correlation ID
  app.use(correlationMiddleware);

  // API versioning
  app.use(apiVersionMiddleware);

  // JSON body parser with raw body capture for webhook signature verification
  app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  }));
  app.use(express.urlencoded({ extended: true }));

  // Request normalization — phones, emails, string trimming, tenantId
  app.use(requestNormalization);

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : (ms > 1000 || res.statusCode >= 400) ? 'warn' : 'info';
      logger[level]('[REQ]', {
        requestId: res.getHeader('x-request-id'),
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration_ms: ms,
        slow: ms > 1000 || undefined,
      });
    });
    next();
  });

  // Prometheus HTTP duration middleware — records after the response is flushed
  // Skips /metrics itself to avoid self-referential noise
  app.use((req, res, next) => {
    if (req.path === '/metrics') return next();
    const start = Date.now();
    res.on('finish', () => {
      try {
        const { httpRequestDuration } = require('../utils/prom-metrics');
        httpRequestDuration
          .labels(req.method, req.route?.path || req.path, String(res.statusCode))
          .observe(Date.now() - start);
      } catch (_) { /* prom-client not available — fail silently */ }
    });
    next();
  });
}

module.exports = { setupMiddleware };
