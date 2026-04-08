const { logger } = require('./logger');

/**
 * Client Data Isolation Middleware
 * Ensures client API keys can only access their own data.
 * Prevents cross-client data leakage.
 */

/**
 * Middleware: enforce client isolation on routes with :clientId param.
 * If request was authenticated with a per-client API key, the clientId in
 * the URL must match the key's client_id.
 */
function enforceClientIsolation(req, res, next) {
  // Admin keys bypass isolation
  if (req.isAdmin) return next();

  // If authenticated with client key, enforce isolation
  if (req.clientId) {
    const urlClientId = req.params.clientId || req.query.clientId || req.query.client_id;
    if (urlClientId && urlClientId !== req.clientId) {
      logger.error(`[SECURITY] Client isolation bypass attempt - Client ${req.clientId} tried to access ${urlClientId} data via URL/query params. IP: ${req.ip}`);
      return res.status(403).json({
        error: 'Access denied — you can only access your own client data',
      });
    }
    // Auto-inject clientId into body for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      req.body.client_id = req.body.client_id || req.clientId;
    }
  }

  next();
}

/**
 * Permission check middleware factory.
 * @param {string} requiredPermission - 'read' | 'write' | 'admin'
 */
function requirePermission(requiredPermission) {
  return (req, res, next) => {
    if (req.isAdmin) return next();

    const permissions = req.keyPermissions || ['read'];
    if (!permissions.includes(requiredPermission) && !permissions.includes('admin')) {
      return res.status(403).json({
        error: `Insufficient permissions — requires '${requiredPermission}'`,
      });
    }
    next();
  };
}

/**
 * Extract and validate clientId from various sources.
 * Priority: URL param > query > body > API key
 */
function resolveClientId(req) {
  return req.params.clientId || req.query.clientId || req.body?.client_id || req.clientId || null;
}

/**
 * router.param() callback for tenant isolation on :clientId URL params.
 * Add `router.param('clientId', clientIsolationParam)` at the top of any
 * sub-router that has routes with a :clientId segment. Unlike enforceClientIsolation
 * (which runs before route matching), this fires after Express captures the param.
 */
function clientIsolationParam(req, res, next, clientId) {
  if (req.isAdmin) return next();
  if (req.clientId && clientId !== req.clientId) {
    logger.error(`[SECURITY] Tenant isolation bypass — auth client=${req.clientId} tried to access client=${clientId} IP=${req.ip}`);
    return res.status(403).json({ error: 'Access denied — you can only access your own client data' });
  }
  next();
}

module.exports = { enforceClientIsolation, requirePermission, resolveClientId, clientIsolationParam };
