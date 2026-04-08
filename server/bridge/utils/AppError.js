/**
 * Structured application error.
 * Carries a machine-readable code, a human-readable message, and an HTTP status code.
 * Route handlers should throw AppError (or pass it to next()) instead of generic Error
 * so the error handler can return a consistent JSON contract.
 */
class AppError extends Error {
  /**
   * @param {string} code - Machine-readable error code (e.g. 'NOT_FOUND', 'VALIDATION_ERROR')
   * @param {string} message - Human-readable description
   * @param {number} [statusCode=500] - HTTP status code to send
   */
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;

    // Maintain proper prototype chain in transpiled environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }
}

module.exports = { AppError };
