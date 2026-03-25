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
    const urlClientId = req.params.clientId;
    if (urlClientId && urlClientId !== req.clientId) {
      console.warn(`[isolation] Client ${req.clientId} tried to access ${urlClientId} data`);
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

module.exports = { enforceClientIsolation, requirePermission, resolveClientId };
