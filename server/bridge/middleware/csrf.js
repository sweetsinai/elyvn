/**
 * CSRF Protection Middleware
 *
 * For state-changing requests (POST, PUT, DELETE, PATCH), verifies that the
 * request is legitimate by checking one of:
 *   1. Valid API key present (handled upstream by apiAuth — detected via req.clientId or req.isAdmin)
 *   2. Valid JWT Bearer token (detected via req.isJwtAuth)
 *   3. X-Requested-With header is present (standard AJAX marker, not sent by simple forms)
 *   4. Origin header matches CORS_ORIGINS allowlist
 *
 * Webhook endpoints are skipped — they use their own signature verification.
 */

const { logger } = require('../utils/logger');

// Paths that use webhook signature verification and must be excluded from CSRF
const WEBHOOK_PREFIXES = [
  '/webhooks/retell',
  '/retell-webhook',
  '/webhooks/telnyx',
  '/webhooks/twilio',
  '/webhooks/calcom',
  '/webhooks/telegram',
  '/webhooks/form',
  '/billing/webhook',
];

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function csrfProtection(req, res, next) {
  // Only check state-changing methods
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    return next();
  }

  // Skip webhook endpoints — they have their own signature auth
  const pathLower = req.path.toLowerCase();
  for (const prefix of WEBHOOK_PREFIXES) {
    if (pathLower.startsWith(prefix)) {
      return next();
    }
  }

  // 1. Request was already authenticated via API key or JWT (set by apiAuth middleware)
  if (req.clientId || req.isAdmin || req.isJwtAuth) {
    return next();
  }

  // 2. AJAX marker header (browsers won't send this in a simple cross-origin form POST)
  if (req.headers['x-requested-with']) {
    return next();
  }

  // 3. Origin matches allowed origins
  const origin = req.headers['origin'];
  if (origin) {
    const allowed = [
      'https://elyvn.ai',
      'https://app.elyvn.ai',
      'https://dashboard-nine-ebon-97.vercel.app',
      ...(process.env.DASHBOARD_URL ? [process.env.DASHBOARD_URL] : []),
      ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    ];

    if (allowed.includes(origin)) {
      return next();
    }

    // In dev with no CORS_ORIGINS configured, allow through
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
  }

  // In non-production, be lenient — log a warning but allow
  if (process.env.NODE_ENV !== 'production') {
    logger.warn(`[csrf] Suspicious ${req.method} ${req.path} — no auth, no AJAX header, origin: ${origin || 'none'}`);
    return next();
  }

  logger.warn(`[csrf] Blocked ${req.method} ${req.path} — failed CSRF checks (origin: ${origin || 'none'}, ip: ${req.ip})`);
  return res.status(403).json({ code: 'CSRF_REJECTED', message: 'Request rejected — missing authentication or invalid origin' });
}

module.exports = { csrfProtection };
