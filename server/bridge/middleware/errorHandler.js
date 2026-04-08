/**
 * Centralized error handler middleware.
 * Must be mounted AFTER all routes in index.js.
 *
 * Handles AppError instances with structured JSON responses:
 *   { code, message, requestId }
 *
 * Falls through to the existing legacy error handler for non-AppError cases
 * so backward-compat error strings are preserved for SyntaxError, DB errors, etc.
 */
const { AppError } = require('../utils/AppError');
const { logger } = require('../utils/logger');

/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    // Log at warn level for client errors, error level for server errors
    const logLevel = err.statusCode >= 500 ? 'error' : 'warn';
    logger[logLevel](`[errorHandler] ${err.code} (${err.statusCode}): ${err.message}`);

    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      requestId: req.id || undefined,
    });
  }

  // Not an AppError — pass to the next error handler (legacy handler in index.js)
  return next(err);
}

module.exports = { errorHandler };
