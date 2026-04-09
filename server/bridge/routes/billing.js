/**
 * Stripe billing routes for ELYVN
 * Handles checkout sessions, webhooks, and billing portal
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../utils/logger');
const { verifyToken } = require('./auth');
const { logDataMutation } = require('../utils/auditLog');
const { AppError } = require('../utils/AppError');
const { validateBody } = require('../middleware/validateRequest');
const { CreateCheckoutSchema } = require('../utils/schemas/billing');

// Stripe plans configuration
const PLANS = {
  solo: {
    name: 'Solo',
    price: 9900, // $99 in cents
    priceId: process.env.STRIPE_PRICE_SOLO,
    calls: 100,
  },
  starter: {
    name: 'Starter',
    price: 29900, // $299 in cents
    priceId: process.env.STRIPE_PRICE_STARTER,
    calls: 500,
  },
  growth: {
    name: 'Growth',
    price: 49900, // $499 in cents
    priceId: process.env.STRIPE_PRICE_GROWTH,
    calls: 1500,
  },
  scale: {
    name: 'Scale',
    price: 79900, // $799 in cents
    priceId: process.env.STRIPE_PRICE_SCALE,
    calls: -1, // unlimited
  },
};

// Lazy-load Stripe (only when keys are configured)
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new AppError('INTERNAL_ERROR', 'STRIPE_SECRET_KEY not configured', 500);
  }
  // Dynamic require to avoid crash if stripe not installed
  try {
    const Stripe = require('stripe');
    return new Stripe(process.env.STRIPE_SECRET_KEY);
  } catch {
    throw new AppError('INTERNAL_ERROR', 'stripe package not installed — run: npm install stripe', 500);
  }
}

// JWT auth middleware for billing routes
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.clientId = payload.clientId;
  req.email = payload.email;
  next();
}

// GET /billing/plans — list available plans
router.get('/plans', (req, res) => {
  const plans = Object.entries(PLANS).map(([key, plan]) => ({
    id: key,
    name: plan.name,
    price: plan.price / 100,
    calls: plan.calls === -1 ? 'Unlimited' : plan.calls,
  }));
  res.json({ plans });
});

// POST /billing/create-checkout — create Stripe checkout session
router.post('/create-checkout', requireAuth, validateBody(CreateCheckoutSchema), async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];

  if (!plan) {
    return res.status(400).json({ error: 'Invalid plan. Choose: starter, growth, or scale' });
  }

  try {
    const stripe = getStripe();
    const db = req.app.locals.db;

    // Get client info
    const client = await db.query('SELECT id, owner_email, stripe_customer_id FROM clients WHERE id = ?', [req.clientId], 'get');
    if (!client) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Create or reuse Stripe customer
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: client.owner_email,
        metadata: { clientId: req.clientId },
      });
      customerId = customer.id;
      await db.query('UPDATE clients SET stripe_customer_id = ? WHERE id = ?', [customerId, req.clientId], 'run');
    }

    const sessionParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `ELYVN ${plan.name}`,
            description: `AI Receptionist — ${plan.calls === -1 ? 'Unlimited' : plan.calls} calls/month`,
          },
          unit_amount: plan.price,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      client_reference_id: req.clientId,
      metadata: { clientId: req.clientId, planId },
      success_url: `${process.env.APP_URL || 'https://api.elyvn.net'}/dashboard?payment=success`,
      cancel_url: `${process.env.APP_URL || 'https://api.elyvn.net'}/dashboard?payment=cancelled`,
      subscription_data: {
        trial_period_days: 7,
        metadata: { clientId: req.clientId, planId },
      },
    };

    // Use Stripe price ID if configured, otherwise use price_data
    if (plan.priceId) {
      sessionParams.line_items = [{ price: plan.priceId, quantity: 1 }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    logger.info(`[billing] Checkout session created for ${req.email} — plan: ${planId}`);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    logger.error('[billing] Checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /billing/webhook — Stripe webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // In production, require webhook signature verification
  if (!webhookSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[billing] STRIPE_WEBHOOK_SECRET not set in production — rejecting webhook');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    logger.warn('[billing] STRIPE_WEBHOOK_SECRET not set — skipping signature verification');
  }

  let event;
  try {
    const stripe = getStripe();
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, webhookSecret);
    } else if (process.env.NODE_ENV !== 'production') {
      event = JSON.parse(typeof req.body === 'string' ? req.body : req.rawBody || JSON.stringify(req.body));
    } else {
      logger.error('[billing] Unsigned webhook rejected in production');
      return res.status(400).json({ error: 'Webhook signature required' });
    }
  } catch (err) {
    logger.error('[billing] Webhook signature verification failed:', err.message);
    try {
      const { logAudit } = require('../utils/auditLog');
      const db = req.app?.locals?.db;
      if (db) logAudit(db, { action: 'webhook_signature_invalid', ip: req.ip, details: { source: 'stripe', error: err.message } });
    } catch (_) {}
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const db = req.app.locals.db;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const clientId = session.client_reference_id || session.metadata?.clientId;
        const planId = session.metadata?.planId || 'starter';

        if (clientId) {
          await db.query(`
            UPDATE clients SET
              stripe_customer_id = ?,
              stripe_subscription_id = ?,
              plan = ?,
              subscription_status = 'active',
              plan_started_at = datetime('now'),
              updated_at = datetime('now')
            WHERE id = ?
          `, [session.customer, session.subscription, planId, clientId], 'run');

          logger.info(`[billing] Client ${clientId} activated — plan: ${planId}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: clientId, newValues: { plan: planId, subscription_status: 'active' } }); } catch (_) {}
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const client = await db.query('SELECT id FROM clients WHERE stripe_customer_id = ?', [customerId], 'get');
        if (client) {
          await db.query("UPDATE clients SET subscription_status = 'active', updated_at = datetime('now') WHERE id = ?", [client.id], 'run');
          logger.info(`[billing] Payment succeeded for client ${client.id}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: client.id, newValues: { subscription_status: 'active' } }); } catch (_) {}
        } else {
          logger.warn(`[billing] ${event.type} — no client found for customerId ${customerId}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const client = await db.query('SELECT id FROM clients WHERE stripe_customer_id = ?', [customerId], 'get');
        if (client) {
          await db.query("UPDATE clients SET subscription_status = 'past_due', updated_at = datetime('now') WHERE id = ?", [client.id], 'run');
          logger.warn(`[billing] Payment failed for client ${client.id}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: client.id, newValues: { subscription_status: 'past_due' } }); } catch (_) {}
        } else {
          logger.warn(`[billing] ${event.type} — no client found for customerId ${customerId}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const client = await db.query('SELECT id FROM clients WHERE stripe_customer_id = ?', [customerId], 'get');
        if (client) {
          await db.query("UPDATE clients SET subscription_status = 'canceled', plan = 'canceled', updated_at = datetime('now') WHERE id = ?", [client.id], 'run');
          logger.info(`[billing] Subscription canceled for client ${client.id}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: client.id, newValues: { subscription_status: 'canceled', plan: 'canceled' } }); } catch (_) {}
        } else {
          logger.warn(`[billing] ${event.type} — no client found for customerId ${customerId}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const client = await db.query('SELECT id FROM clients WHERE stripe_customer_id = ?', [customerId], 'get');
        if (client) {
          const status = sub.cancel_at_period_end ? 'canceling' : sub.status;
          await db.query(
            "UPDATE clients SET subscription_status = ?, stripe_subscription_id = ?, updated_at = datetime('now') WHERE id = ?",
            [status, sub.id, client.id],
            'run'
          );
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: client.id, newValues: { subscription_status: status, stripe_subscription_id: sub.id } }); } catch (_) {}
        } else {
          logger.warn(`[billing] ${event.type} — no client found for customerId ${customerId}`);
        }
        break;
      }
    }
  } catch (err) {
    logger.error(`[billing] Webhook processing error (${event.type}):`, err.message);
  }

  res.json({ received: true });
});

// GET /billing/status — get current billing status
router.get('/status', requireAuth, async (req, res) => {
  const db = req.app.locals.db;
  const client = await db.query(
    'SELECT plan, subscription_status, stripe_customer_id, stripe_subscription_id, plan_started_at FROM clients WHERE id = ?',
    [req.clientId],
    'get'
  );

  if (!client) {
    return res.status(404).json({ error: 'Account not found' });
  }

  res.json({
    plan: client.plan || 'trial',
    status: client.subscription_status || 'active',
    has_payment: !!client.stripe_customer_id,
    started_at: client.plan_started_at,
  });
});

// POST /billing/portal — create Stripe billing portal session
router.post('/portal', requireAuth, async (req, res) => {
  const db = req.app.locals.db;
  const client = await db.query('SELECT stripe_customer_id FROM clients WHERE id = ?', [req.clientId], 'get');

  if (!client?.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
  }

  try {
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripe_customer_id,
      return_url: `${process.env.APP_URL || 'https://api.elyvn.net'}/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    logger.error('[billing] Portal error:', err.message);
    res.status(500).json({ error: 'Failed to create billing portal' });
  }
});

module.exports = router;
