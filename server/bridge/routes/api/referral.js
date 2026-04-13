/**
 * Referral Program API
 * Generate referral codes, track referrals, award credits.
 */
const express = require('express');
const router = express.Router();
const { randomUUID, randomBytes } = require('crypto');
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { clientIsolationParam } = require('../../utils/clientIsolation');
const { success } = require('../../utils/response');
const { validateParams, validateBody } = require('../../middleware/validateRequest');
const { ClientParamsSchema } = require('../../utils/schemas/client');
const { z } = require('zod');
const { UUIDSchema } = require('../../utils/schemas/common');

const ReferralApplySchema = z.object({
  referral_code: z.string().min(1).max(50),
  new_client_id: UUIDSchema,
});
router.param('clientId', clientIsolationParam);

const REFERRAL_CREDIT_CENTS = 5000; // $50 credit per successful referral

// GET /referral/:clientId — Get referral code + stats
router.get('/referral/:clientId', validateParams(ClientParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    let client = await db.query('SELECT referral_code, referral_credits FROM clients WHERE id = ?', [clientId], 'get');
    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    // Auto-generate referral code if none exists
    if (!client.referral_code) {
      const code = 'ELYVN-' + randomBytes(4).toString('hex').toUpperCase();
      await db.query("UPDATE clients SET referral_code = ?, updated_at = ? WHERE id = ?", [code, new Date().toISOString(), clientId], 'run');
      client.referral_code = code;
    }

    const referrals = await db.query(
      `SELECT r.id, r.status, r.credit_cents, r.created_at, c.business_name
       FROM referrals r JOIN clients c ON c.id = r.referred_id
       WHERE r.referrer_id = ? ORDER BY r.created_at DESC`,
      [clientId], 'all'
    );

    const totalEarned = referrals.reduce((sum, r) => sum + (r.credit_cents || 0), 0);

    return success(res, {
      referral_code: client.referral_code,
      referral_link: `https://elyvn.ai/signup?ref=${client.referral_code}`,
      credits_available: client.referral_credits || 0,
      total_earned_cents: totalEarned,
      referrals: referrals.map(r => ({
        business_name: r.business_name,
        status: r.status,
        credit: r.credit_cents,
        date: r.created_at,
      })),
    });
  } catch (err) {
    logger.error('[referral] Error:', err);
    next(err);
  }
});

// POST /referral/apply — Apply a referral code during signup (internal only — called from auth/signup)
// Protected by apiAuth at the route mount level in config/routes.js
router.post('/referral/apply', validateBody(ReferralApplySchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { referral_code, new_client_id } = req.body;

    // Find referrer by code
    const referrer = await db.query('SELECT id FROM clients WHERE referral_code = ?', [referral_code], 'get');
    if (!referrer) {
      return success(res, { applied: false, reason: 'Invalid referral code' });
    }

    // Prevent self-referral
    if (referrer.id === new_client_id) {
      return success(res, { applied: false, reason: 'Cannot refer yourself' });
    }

    // Check for duplicate
    const existing = await db.query(
      'SELECT id FROM referrals WHERE referrer_id = ? AND referred_id = ?',
      [referrer.id, new_client_id], 'get'
    );
    if (existing) {
      return success(res, { applied: false, reason: 'Referral already recorded' });
    }

    // Create referral record
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO referrals (id, referrer_id, referred_id, status, credit_cents, created_at)
       VALUES (?, ?, ?, 'pending', 0, ?)`,
      [randomUUID(), referrer.id, new_client_id, now], 'run'
    );

    // Mark the new client as referred
    await db.query("UPDATE clients SET referred_by = ?, updated_at = ? WHERE id = ?", [referrer.id, now, new_client_id], 'run');

    logger.info(`[referral] Code ${referral_code} applied — referrer ${referrer.id} → new ${new_client_id}`);
    return success(res, { applied: true });
  } catch (err) {
    logger.error('[referral] Apply error:', err);
    next(err);
  }
});

// POST /referral/:clientId/activate — Called when referred client makes first payment (from billing webhook)
router.post('/referral/:clientId/activate', validateParams(ClientParamsSchema), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;

    // Atomically claim the referral — prevents double-credit race condition
    const claimed = await db.query(
      "UPDATE referrals SET status = 'paid', credit_cents = ? WHERE referred_id = ? AND status = 'pending'",
      [REFERRAL_CREDIT_CENTS, clientId], 'run'
    );
    if (!claimed || claimed.changes === 0) return success(res, { activated: false, reason: 'No pending referral' });

    // Find the referrer to award credit
    const referral = await db.query(
      "SELECT id, referrer_id FROM referrals WHERE referred_id = ? AND status = 'paid'",
      [clientId], 'get'
    );
    if (!referral) return success(res, { activated: false, reason: 'Referral not found' });
    await db.query(
      'UPDATE clients SET referral_credits = COALESCE(referral_credits, 0) + ? WHERE id = ?',
      [REFERRAL_CREDIT_CENTS, referral.referrer_id], 'run'
    );

    logger.info(`[referral] Activated — referrer ${referral.referrer_id} earned $${REFERRAL_CREDIT_CENTS / 100}`);
    return success(res, { activated: true, credit_cents: REFERRAL_CREDIT_CENTS });
  } catch (err) {
    logger.error('[referral] Activate error:', err);
    next(err);
  }
});

module.exports = router;
