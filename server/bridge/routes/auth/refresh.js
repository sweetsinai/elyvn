/**
 * POST /auth/refresh
 * Rotates a refresh token and returns a new access token.
 */
const express = require('express');
const router = express.Router();
const { rotateRefreshToken } = require('../../utils/tokenService');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');

router.post('/', async (req, res, next) => {
  const { refreshToken } = req.body;
  const db = req.app.locals.db;

  if (!refreshToken) {
    return next(new AppError('MISSING_FIELD', 'refreshToken is required', 400));
  }

  try {
    const tokens = await rotateRefreshToken(db, refreshToken);
    res.json(tokens);
  } catch (err) {
    if (err.message === 'INVALID_REFRESH_TOKEN') {
      return next(new AppError('UNAUTHORIZED', 'Invalid or expired refresh token', 401));
    }
    logger.error('[auth] Refresh error:', err.message);
    next(err);
  }
});

module.exports = router;
