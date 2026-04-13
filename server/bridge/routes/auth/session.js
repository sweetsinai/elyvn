/**
 * GET  /auth/me      — return current user from JWT
 * POST /auth/refresh — issue a new token
 */
const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { verifyToken, createToken } = require('./utils');

// GET /auth/me
router.get('/me', async (req, res, next) => {
  const db = req.app.locals.db;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError('UNAUTHORIZED', 'No token provided', 401));
  }

  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return next(new AppError('UNAUTHORIZED', 'Invalid or expired token', 401));
  }

  try {
    const client = await db.query(
      'SELECT id, business_name, owner_name, owner_email, owner_phone, plan, subscription_status, dodo_customer_id, industry, email_verified, created_at FROM clients WHERE id = ?',
      [payload.clientId],
      'get'
    );

    if (!client) {
      return next(new AppError('NOT_FOUND', 'Account not found', 404));
    }

    res.json({
      clientId: client.id,
      email: client.owner_email,
      business_name: client.business_name,
      owner_name: client.owner_name,
      plan: client.plan || 'trial',
      subscription_status: client.subscription_status || 'active',
      industry: client.industry,
      email_verified: client.email_verified === 1,
      created_at: client.created_at,
    });
  } catch (err) {
    logger.error('[auth] /me error:', err.message);
    return next(new AppError('INTERNAL_ERROR', 'Failed to get user info', 500));
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError('UNAUTHORIZED', 'No token provided', 401));
  }

  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return next(new AppError('UNAUTHORIZED', 'Invalid or expired token', 401));
  }

  const db = req.app.locals.db;
  const client = await db.query('SELECT id, is_active FROM clients WHERE id = ?', [payload.clientId], 'get');
  if (!client || !client.is_active) {
    return res.status(401).json({ error: 'Account not found or inactive' });
  }

  const newToken = createToken({ clientId: payload.clientId, email: payload.email });
  res.json({ token: newToken });
});

module.exports = router;
