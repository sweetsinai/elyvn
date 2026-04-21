/**
 * Rate Limit Middleware
 *
 * Named limiters for each traffic tier, built on BoundedRateLimiter.
 * Import the specific limiter you need and apply it to a route.
 *
 * Tiers:
 *   publicWebhookLimiter  — 300/min per IP  (Retell, Twilio)
 *   authLimiter           — 10/min per IP   (login, signup — already applied in routes.js)
 *   leadLimiter           — 60/min per client
 *   emailSendLimiter      — 20/min per client
 *   scrapeLimiter         — 5/min per client (expensive Google Places + website fetching)
 */

const { BoundedRateLimiter } = require('../utils/rateLimiter');
const { logger } = require('../utils/logger');

// Limiters
const publicWebhookLimiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 300, maxEntries: 20000 });
const leadLimiter          = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 60,  maxEntries: 10000 });
const emailSendLimiter     = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 20,  maxEntries: 10000 });
const scrapeLimiter        = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 5,   maxEntries: 5000  });

/**
 * Factory: builds an Express middleware from a BoundedRateLimiter.
 * Key defaults to clientId (for authenticated routes) then req.ip.
 */
function makeMiddleware(limiter, label) {
  return (req, res, next) => {
    const key = req.clientId || req.ip || req.connection?.remoteAddress || 'unknown';
    const result = limiter.check(key);

    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      logger.warn(`[rateLimit] ${label} exceeded for ${key}`);
      res.set('Retry-After', String(result.retryAfter || 60));
      const requestId = req.id || req.headers['x-request-id'] || 'unknown';
      return res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests', requestId });
    }
    next();
  };
}

const publicWebhookLimit = makeMiddleware(publicWebhookLimiter, 'publicWebhook');
const leadLimit          = makeMiddleware(leadLimiter,          'lead');
const emailSendLimit     = makeMiddleware(emailSendLimiter,     'emailSend');
const scrapeLimit        = makeMiddleware(scrapeLimiter,        'scrape');

/**
 * Cleanup all limiters — call periodically to free memory.
 */
function cleanupAllLimiters() {
  publicWebhookLimiter.cleanup();
  leadLimiter.cleanup();
  emailSendLimiter.cleanup();
  scrapeLimiter.cleanup();
}

module.exports = {
  // Middleware
  publicWebhookLimit,
  leadLimit,
  emailSendLimit,
  scrapeLimit,
  // Raw limiters (for cleanup)
  publicWebhookLimiter,
  leadLimiter,
  emailSendLimiter,
  scrapeLimiter,
  cleanupAllLimiters,
};
