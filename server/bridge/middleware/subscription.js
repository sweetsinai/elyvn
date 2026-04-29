const { logger } = require('../utils/logger');

/**
 * Subscription Status Middleware
 * Ensures clients have an active subscription or are within their grace period.
 */
function checkSubscriptionStatus(req, res, next) {
  // Admin bypasses subscription checks
  if (req.isAdmin) return next();

  // If no clientId, we can't check subscription (e.g. public routes)
  if (!req.clientId) return next();

  const db = req.app.locals.db;
  if (!db) return next();

  // We use a lazy check here to avoid hitting the DB on every request if possible,
  // but since we need the current status, we'll do a quick query.
  db.query(
    'SELECT plan, subscription_status, grace_period_until FROM clients WHERE id = ?',
    [req.clientId],
    'get'
  ).then(client => {
    if (!client) {
      return res.status(404).json({ error: 'Client account not found' });
    }

    const status = client.subscription_status || 'active';
    const plan = client.plan || 'trial';

    // Allow active or trialing clients
    if (status === 'active') return next();

    // Check grace period for past_due accounts
    if (status === 'past_due' && client.grace_period_until) {
      const graceUntil = new Date(client.grace_period_until);
      if (graceUntil > new Date()) {
        logger.info(`[billing] Client ${req.clientId} is past_due but within grace period until ${client.grace_period_until}`);
        return next();
      }
    }

    // Deny access for canceled or expired accounts
    logger.warn(`[billing] Access denied for client ${req.clientId} — status: ${status}, plan: ${plan}`);
    res.status(403).json({
      code: 'SUBSCRIPTION_REQUIRED',
      error: 'Your subscription is inactive or past due. Please update your payment method.',
      status: status,
      grace_period_expired: status === 'past_due'
    });
  }).catch(err => {
    logger.error('[billing] Subscription check error:', err.message);
    next(); // Fail open on DB error for safety? Or fail closed? Fail open for now.
  });
}

module.exports = { checkSubscriptionStatus };
