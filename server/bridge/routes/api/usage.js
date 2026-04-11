/**
 * Usage Metering, Plan Management, and Onboarding API
 * Tracks monthly usage, handles plan upgrades, and manages onboarding steps.
 */
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { isValidUUID } = require('../../utils/validate');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { logDataMutation } = require('../../utils/auditLog');
const { clientIsolationParam } = require('../../utils/clientIsolation');
router.param('clientId', clientIsolationParam);

// Plan limits
const PLAN_LIMITS = {
  trial:   { calls: 50,   sms: 100,  emails: 50  },
  starter: { calls: 500,  sms: 1000, emails: 200 },
  pro:     { calls: 1500, sms: 3000, emails: 500 },
  premium: { calls: -1,   sms: -1,   emails: -1  }, // unlimited
  // Legacy plan names (backward compat for existing clients)
  solo:    { calls: 100,  sms: 300,  emails: 100 },
  growth:  { calls: 1500, sms: 3000, emails: 500 },
  scale:   { calls: -1,   sms: -1,   emails: -1  },
};

// GET /usage/:clientId — Current month usage + limits + overage
router.get('/usage/:clientId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const client = await db.query('SELECT plan, calls_this_month, sms_this_month, billing_cycle_start FROM clients WHERE id = ?', [clientId], 'get');
    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const limits = PLAN_LIMITS[client.plan] || PLAN_LIMITS.trial;

    // Get detailed usage from usage_records (or fallback to client counters)
    const usage = await db.query(
      'SELECT calls_count, sms_count, ai_decisions_count, emails_count, overage_calls FROM usage_records WHERE client_id = ? AND month = ?',
      [clientId, month], 'get'
    );

    const callsUsed = usage?.calls_count || client.calls_this_month || 0;
    const smsUsed = usage?.sms_count || client.sms_this_month || 0;

    res.json({
      month,
      plan: client.plan,
      usage: {
        calls: callsUsed,
        sms: smsUsed,
        ai_decisions: usage?.ai_decisions_count || 0,
        emails: usage?.emails_count || 0,
      },
      limits: {
        calls: limits.calls === -1 ? 'unlimited' : limits.calls,
        sms: limits.sms === -1 ? 'unlimited' : limits.sms,
        emails: limits.emails === -1 ? 'unlimited' : limits.emails,
      },
      overage: {
        calls: limits.calls > 0 ? Math.max(0, callsUsed - limits.calls) : 0,
        at_limit: limits.calls > 0 && callsUsed >= limits.calls,
      },
    });
  } catch (err) {
    logger.error('[usage] Error:', err);
    next(err);
  }
});

// POST /usage/:clientId/record — Record a usage event (internal, called by brain/sms/call handlers)
router.post('/usage/:clientId/record', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { type } = req.body; // 'call', 'sms', 'ai_decision', 'email'
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const validTypes = ['call', 'sms', 'ai_decision', 'email'];
    if (!validTypes.includes(type)) return next(new AppError('VALIDATION_ERROR', 'Invalid usage type', 400));

    const month = new Date().toISOString().slice(0, 7);

    // Verify client exists
    const client = await db.query('SELECT id FROM clients WHERE id = ?', [clientId], 'get');
    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    // Upsert usage record — explicit query per type (no dynamic column interpolation)
    const queries = {
      call:         'INSERT INTO usage_records (id, client_id, month, calls_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET calls_count = calls_count + 1',
      sms:          'INSERT INTO usage_records (id, client_id, month, sms_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET sms_count = sms_count + 1',
      ai_decision:  'INSERT INTO usage_records (id, client_id, month, ai_decisions_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET ai_decisions_count = ai_decisions_count + 1',
      email:        'INSERT INTO usage_records (id, client_id, month, emails_count) VALUES (?, ?, ?, 1) ON CONFLICT(client_id, month) DO UPDATE SET emails_count = emails_count + 1',
    };
    await db.query(queries[type], [randomUUID(), clientId, month], 'run');

    // Also update client counters for quick access
    if (type === 'call') {
      await db.query('UPDATE clients SET calls_this_month = COALESCE(calls_this_month, 0) + 1 WHERE id = ?', [clientId], 'run');
    } else if (type === 'sms') {
      await db.query('UPDATE clients SET sms_this_month = COALESCE(sms_this_month, 0) + 1 WHERE id = ?', [clientId], 'run');
    }

    res.json({ recorded: true });
  } catch (err) {
    logger.error('[usage] Record error:', err);
    next(err);
  }
});

// GET /onboarding/:clientId — Get onboarding progress
router.get('/onboarding/:clientId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const client = await db.query(
      'SELECT onboarding_step, onboarding_completed, business_name, industry, phone_number, retell_agent_id, telegram_chat_id, calcom_booking_link, google_review_link FROM clients WHERE id = ?',
      [clientId], 'get'
    );
    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    // 3 essential steps (minimum to go live) + 4 optional (improve experience)
    const essentialSteps = [
      { id: 1, name: 'business_info', label: 'Business name + industry', done: !!(client.business_name && client.industry), required: true },
      { id: 2, name: 'phone_number', label: 'Connect phone number', done: !!client.phone_number, required: true },
      { id: 3, name: 'notifications', label: 'Connect Telegram', done: !!client.telegram_chat_id, required: true },
    ];
    const optionalSteps = [
      { id: 4, name: 'voice_agent', label: 'Configure voice AI', done: !!client.retell_agent_id, required: false },
      { id: 5, name: 'booking', label: 'Set up booking link', done: !!client.calcom_booking_link, required: false },
      { id: 6, name: 'review_link', label: 'Add Google review link', done: !!client.google_review_link, required: false },
      { id: 7, name: 'test_call', label: 'Make a test call', done: (client.onboarding_step || 0) >= 7, required: false },
    ];
    const steps = [...essentialSteps, ...optionalSteps];

    const essentialDone = essentialSteps.filter(s => s.done).length;
    const completedCount = steps.filter(s => s.done).length;
    const pct = Math.round((completedCount / steps.length) * 100);
    const canGoLive = essentialDone === essentialSteps.length;

    res.json({
      steps,
      essential_complete: essentialDone,
      essential_total: essentialSteps.length,
      can_go_live: canGoLive,
      current_step: client.onboarding_step || 0,
      completed: client.onboarding_completed === 1,
      progress_pct: pct,
    });
  } catch (err) {
    logger.error('[onboarding] Error:', err);
    next(err);
  }
});

// POST /onboarding/:clientId/complete-step — Mark a step as complete
router.post('/onboarding/:clientId/complete-step', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { step } = req.body;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));
    if (!step || typeof step !== 'number' || step < 1 || step > 7) {
      return next(new AppError('VALIDATION_ERROR', 'Step must be 1-7', 400));
    }

    const client = await db.query('SELECT onboarding_step FROM clients WHERE id = ?', [clientId], 'get');
    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    const newStep = Math.max(client.onboarding_step || 0, step);
    const completed = newStep >= 7 ? 1 : 0;

    await db.query(
      "UPDATE clients SET onboarding_step = ?, onboarding_completed = ?, updated_at = datetime('now') WHERE id = ?",
      [newStep, completed, clientId], 'run'
    );

    try { logDataMutation(db, { action: 'onboarding_step', table: 'clients', recordId: clientId, newValues: { step: newStep, completed } }); } catch (_) {}

    res.json({ step: newStep, completed: completed === 1 });
  } catch (err) {
    logger.error('[onboarding] Step error:', err);
    next(err);
  }
});

// POST /plan/:clientId/upgrade — Self-serve plan upgrade via Dodo Payments
router.post('/plan/:clientId/upgrade', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { clientId } = req.params;
    const { planId } = req.body;
    if (!isValidUUID(clientId)) return next(new AppError('INVALID_INPUT', 'Invalid client ID', 400));

    const validPlans = ['starter', 'pro', 'premium'];
    if (!validPlans.includes(planId)) {
      return next(new AppError('VALIDATION_ERROR', 'Invalid plan. Choose: starter, pro, or premium', 400));
    }

    const client = await db.query('SELECT plan, dodo_customer_id, owner_email, business_name FROM clients WHERE id = ?', [clientId], 'get');
    if (!client) return next(new AppError('NOT_FOUND', 'Client not found', 404));

    // If Dodo is configured, redirect to checkout
    if (process.env.DODO_API_KEY) {
      try {
        const productIds = {
          starter: process.env.DODO_PRODUCT_STARTER,
          pro: process.env.DODO_PRODUCT_PRO,
          premium: process.env.DODO_PRODUCT_PREMIUM,
        };

        if (!productIds[planId]) {
          await db.query("UPDATE clients SET plan = ?, updated_at = datetime('now') WHERE id = ?", [planId, clientId], 'run');
          try { logDataMutation(db, { action: 'plan_upgrade', table: 'clients', recordId: clientId, newValues: { plan: planId } }); } catch (_) {}
          return res.json({ upgraded: true, plan: planId });
        }

        const DODO_BASE_URL = process.env.DODO_ENV === 'live'
          ? 'https://api.dodopayments.com'
          : 'https://test.dodopayments.com';

        const resp = await fetch(`${DODO_BASE_URL}/checkouts`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.DODO_API_KEY}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            product_cart: [{ product_id: productIds[planId], quantity: 1 }],
            customer: { email: client.owner_email, name: client.business_name || 'ELYVN Customer' },
            metadata: { clientId, planId },
            return_url: `${process.env.APP_URL || 'https://api.elyvn.net'}/dashboard?upgrade=success`,
          }),
        });
        const session = await resp.json();
        if (!resp.ok) throw new Error(session.message || 'Dodo checkout failed');
        return res.json({ checkout_url: session.checkout_url || session.url });
      } catch (dodoErr) {
        logger.error('[plan] Dodo error:', dodoErr.message);
        return next(new AppError('INTERNAL_ERROR', 'Failed to create checkout', 500));
      }
    }

    // No Dodo — direct update (dev/test)
    await db.query("UPDATE clients SET plan = ?, updated_at = datetime('now') WHERE id = ?", [planId, clientId], 'run');
    try { logDataMutation(db, { action: 'plan_upgrade', table: 'clients', recordId: clientId, newValues: { plan: planId } }); } catch (_) {}
    res.json({ upgraded: true, plan: planId });
  } catch (err) {
    logger.error('[plan] Upgrade error:', err);
    next(err);
  }
});

module.exports = router;
