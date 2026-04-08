/**
 * requireVerified — middleware that blocks requests from unverified accounts
 */
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');

async function requireVerified(req, res, next) {
  const db = req.app.locals.db;
  const clientId = req.clientId;

  if (!clientId) {
    return next(new AppError('UNAUTHORIZED', 'Authentication required', 401));
  }

  try {
    const client = await db.query('SELECT email_verified FROM clients WHERE id = ?', [clientId], 'get');
    if (!client) {
      return next(new AppError('NOT_FOUND', 'Account not found', 404));
    }
    if (client.email_verified !== 1) {
      return next(new AppError('FORBIDDEN', 'Email verification required. Please verify your email before performing this action.', 403));
    }
    next();
  } catch (err) {
    logger.error('[auth] requireVerified error:', err.message);
    return next(new AppError('INTERNAL_ERROR', 'Failed to check verification status', 500));
  }
}

module.exports = { requireVerified };
