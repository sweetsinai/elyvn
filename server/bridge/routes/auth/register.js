/**
 * POST /auth/signup
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { sendVerificationEmail } = require('../../utils/verificationEmail');
const config = require('../../utils/config');
const { validateBody } = require('../../middleware/validateRequest');
const { SignupSchema } = require('../../utils/schemas/auth');
const { hashPassword, createToken } = require('./utils');

router.post('/', validateBody(SignupSchema), async (req, res, next) => {
  const db = req.app.locals.db;
  const { email, password, business_name, owner_name, owner_phone } = req.body;

  if (!email || !password || !business_name) {
    return next(new AppError('MISSING_FIELD', 'email, password, and business_name are required', 400));
  }
  if (typeof email !== 'string' || typeof password !== 'string' || typeof business_name !== 'string') {
    return next(new AppError('INVALID_INPUT', 'Invalid input types', 400));
  }
  if (password.length < 8 || password.length > 128) {
    return next(new AppError('VALIDATION_ERROR', 'Password must be 8-128 characters', 400));
  }
  if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
    return next(new AppError('VALIDATION_ERROR', 'Password must contain at least one letter and one number', 400));
  }
  if (email.length > 254 || business_name.length > 200) {
    return next(new AppError('VALIDATION_ERROR', 'Input too long', 400));
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return next(new AppError('VALIDATION_ERROR', 'Invalid email format', 400));
  }

  // Check if email already exists
  const existing = await db.query('SELECT id FROM clients WHERE owner_email = ?', [email.toLowerCase().trim()], 'get');
  if (existing) {
    return next(new AppError('DUPLICATE', 'An account with this email already exists', 409));
  }

  try {
    const clientId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Generate referral code for the new client
    const referralCode = 'ELYVN-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    await db.query(`
      INSERT INTO clients (id, business_name, name, owner_name, owner_email, owner_phone, password_hash, is_active, plan, email_verified, verification_token, verification_expires, referral_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'trial', 0, ?, ?, ?, datetime('now'), datetime('now'))
    `, [clientId, business_name.trim(), business_name.trim(), owner_name?.trim() || '', email.toLowerCase().trim(), owner_phone?.trim() || '', passwordHash, verificationToken, verificationExpires, referralCode], 'run');

    const token = createToken({ clientId, email: email.toLowerCase().trim() });

    // Apply referral code if provided (fire-and-forget)
    const refCode = req.body.referral_code || req.query.ref;
    if (refCode) {
      try {
        const referrer = await db.query('SELECT id FROM clients WHERE referral_code = ?', [refCode], 'get');
        if (referrer && referrer.id !== clientId) {
          await db.query("UPDATE clients SET referred_by = ?, updated_at = datetime('now') WHERE id = ?", [referrer.id, clientId], 'run');
          await db.query(
            `INSERT INTO referrals (id, referrer_id, referred_id, status, credit_cents, created_at) VALUES (?, ?, ?, 'pending', 0, datetime('now'))`,
            [crypto.randomUUID(), referrer.id, clientId], 'run'
          );
          logger.info(`[auth] Referral code ${refCode} applied for new client ${clientId}`);
        }
      } catch (refErr) {
        logger.warn('[auth] Referral application failed:', refErr.message);
      }
    }

    // Send verification email (non-blocking)
    const baseUrl = config.getBaseUrl();
    sendVerificationEmail(email.toLowerCase().trim(), verificationToken, baseUrl).catch(err => {
      logger.error('[auth] Failed to send verification email:', err.message);
    });

    // Post-signup: create Google Sheet (non-blocking)
    try {
      const { createClientSheet, isConfigured } = require('../../utils/googleSheets');
      if (isConfigured()) {
        createClientSheet(business_name.trim(), email.toLowerCase().trim()).then(async (sheet) => {
          if (sheet) {
            await db.query("UPDATE clients SET google_sheet_id = ?, updated_at = datetime('now') WHERE id = ?",
              [sheet.spreadsheetId, clientId], 'run');
          }
        }).catch(() => {});
      }
    } catch (_) {}

    logger.info(`[auth] New signup: ${email} → client ${clientId} (unverified)`);
    res.status(201).json({
      token,
      clientId,
      email: email.toLowerCase().trim(),
      business_name: business_name.trim(),
      message: 'Account created. Please verify your email.',
      email_verified: false,
    });
  } catch (err) {
    logger.error('[auth] Signup error:', err.message);
    return next(new AppError('INTERNAL_ERROR', 'Failed to create account', 500));
  }
});

module.exports = router;
