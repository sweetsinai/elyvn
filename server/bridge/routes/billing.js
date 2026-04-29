/**
 * Dodo Payments billing routes for ELYVN
 * Handles checkout sessions, webhooks, and billing status
 *
 * Replaces Stripe — Dodo is India-friendly with global coverage.
 * Uses Dodo Checkout API + Standard Webhooks for signature verification.
 */
const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const { verifyToken } = require('./auth');
const { logDataMutation } = require('../utils/auditLog');
const { AppError } = require('../utils/AppError');
const { validateBody } = require('../middleware/validateRequest');
const { z } = require('zod');
const config = require('../utils/config');
const { API_TIMEOUT_MS } = require('../config/timing');
const { LRUCache } = require('lru-cache');

// Webhook idempotency cache (stores processed webhook IDs for 24 hours)
const processedWebhooks = new LRUCache({
  max: 10000,
  ttl: 1000 * 60 * 60 * 24, // 24 hours
});

// ─── Plan configuration ─────────────────────────────────────────────────────

const PLANS = config.plans;

// ─── Dodo API client ────────────────────────────────────────────────────────

const DODO_API_KEY = process.env.DODO_API_KEY;
const DODO_BASE_URL = process.env.DODO_ENV === 'live'
  ? 'https://api.dodopayments.com'
  : 'https://test.dodopayments.com';

async function dodoRequest(method, path, body) {
  if (!DODO_API_KEY) {
    throw new AppError('INTERNAL_ERROR', 'DODO_API_KEY not configured', 500);
  }
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${DODO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS || 30000),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${DODO_BASE_URL}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    logger.error(`[billing] Dodo API error: ${res.status}`, JSON.stringify(data));
    throw new AppError('PAYMENT_ERROR', data.message || 'Payment provider error', res.status >= 500 ? 502 : 400);
  }
  return data;
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const CreateCheckoutSchema = z.object({
  planId: z.enum(['growth', 'pro', 'elite']),
});

// ─── Auth middleware ────────────────────────────────────────────────────────

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

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /billing/plans — list available plans
router.get('/plans', (req, res) => {
  const mainPlanIds = ['trial', 'growth', 'pro', 'elite'];
  const plans = Object.entries(PLANS)
    .filter(([key]) => mainPlanIds.includes(key))
    .map(([key, plan]) => ({
      id: key,
      name: plan.name,
      price: plan.price,
      calls: plan.calls === -1 ? 'Unlimited' : plan.calls,
      sms: plan.sms === -1 ? 'Unlimited' : plan.sms,
    }));
  res.json({ plans });
});

// POST /billing/create-checkout — create Dodo checkout session
router.post('/create-checkout', requireAuth, validateBody(CreateCheckoutSchema), async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];

  if (!plan) {
    return res.status(400).json({ error: 'Invalid plan. Choose: growth, pro, or elite' });
  }

  try {
    const db = req.app.locals.db;
    const client = await db.query(
      'SELECT id, owner_email, business_name, dodo_customer_id FROM clients WHERE id = ?',
      [req.clientId], 'get'
    );
    if (!client) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const appUrl = process.env.APP_URL || 'https://api.elyvn.net';

    // Create Dodo checkout session
    const session = await dodoRequest('POST', '/checkouts', {
      product_cart: [{ product_id: plan.productId, quantity: 1 }],
      customer: {
        email: client.owner_email || req.email,
        name: client.business_name || 'ELYVN Customer',
      },
      metadata: {
        clientId: req.clientId,
        planId,
      },
      return_url: `${appUrl}/dashboard?payment=success`,
    });

    logger.info(`[billing] Dodo checkout created for ${req.email} — plan: ${planId}`);
    res.json({ url: session.checkout_url || session.url, sessionId: session.checkout_id || session.id });
  } catch (err) {
    logger.error('[billing] Checkout error:', err.message);
    if (err instanceof AppError) throw err;
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /billing/generate-link — Admin: generate a checkout link for any client
router.post('/generate-link', requireAuth, validateBody(z.object({
  clientId: z.string().uuid(),
  planId: z.enum(['growth', 'pro', 'elite']),
})), async (req, res) => {
  try {
    const db = req.app.locals.db;
    // Verify caller is admin
    const caller = await db.query('SELECT role FROM clients WHERE id = ?', [req.clientId], 'get');
    const isAdmin = caller?.role === 'admin';
    
    // Fallback to API key for automated tools if configured
    const provided = req.headers['x-api-key'] || '';
    const expected = process.env.ELYVN_API_KEY || '';
    const isApiKeyValid = provided.length > 0 && expected.length > 0 &&
      provided.length === expected.length &&
      require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

    if (!isAdmin && !isApiKeyValid) return res.status(403).json({ error: 'Admin access required' });

    const { clientId, planId } = req.body;
    const plan = PLANS[planId];
    const client = await db.query('SELECT id, owner_email, business_name FROM clients WHERE id = ?', [clientId], 'get');
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const appUrl = process.env.APP_URL || 'https://api.elyvn.net';
    const session = await dodoRequest('POST', '/checkouts', {
      product_cart: [{ product_id: plan.productId, quantity: 1 }],
      customer: {
        email: client.owner_email || 'unknown@elyvn.net',
        name: client.business_name || 'ELYVN Customer',
      },
      metadata: { clientId, planId },
      return_url: `${appUrl}/dashboard?payment=success`,
    });

    const checkoutUrl = session.checkout_url || session.url;
    logger.info(`[billing] Admin generated checkout link for client ${clientId} — plan: ${planId}`);
    res.json({ url: checkoutUrl, clientId, planId, clientEmail: client.owner_email });
  } catch (err) {
    logger.error('[billing] Generate link error:', err.message);
    if (err instanceof AppError) throw err;
    res.status(500).json({ error: 'Failed to generate checkout link' });
  }
});

// POST /billing/webhook — Dodo webhook handler (Standard Webhooks)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.DODO_WEBHOOK_SECRET;

  if (!webhookSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[billing] DODO_WEBHOOK_SECRET not set in production — rejecting webhook');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    logger.warn('[billing] DODO_WEBHOOK_SECRET not set — skipping signature verification');
  }

  // Parse and verify webhook
  let payload;
  const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');

  try {
    if (webhookSecret) {
      const { Webhook } = require('standardwebhooks');
      const wh = new Webhook(webhookSecret);
      const headers = {
        'webhook-id': req.headers['webhook-id'],
        'webhook-signature': req.headers['webhook-signature'],
        'webhook-timestamp': req.headers['webhook-timestamp'],
      };
      payload = wh.verify(rawBody, headers);
    } else if (process.env.NODE_ENV !== 'production') {
      payload = JSON.parse(rawBody);
    } else {
      return res.status(400).json({ error: 'Webhook signature required' });
    }
  } catch (err) {
    logger.error('[billing] Webhook signature verification failed:', err.message);
    try {
      const { logAudit } = require('../utils/auditLog');
      const db = req.app?.locals?.db;
      if (db) logAudit(db, { action: 'webhook_signature_invalid', ip: req.ip, details: { source: 'dodo', error: err.message } });
    } catch (_) {}
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const db = req.app.locals.db;
  const eventType = payload.type || payload.event_type || '';
  const data = payload.data || payload;
  const webhookId = req.headers['webhook-id'] || payload.id;

  // Idempotency check: prevent double processing
  if (webhookId) {
    // 1. Check in-memory cache first (fast)
    if (processedWebhooks.has(webhookId)) {
      logger.info(`[billing] Webhook ${webhookId} already processed (cache), skipping.`);
      return res.json({ received: true });
    }
    
    // 2. Check DB (persistent)
    const existing = await db.query('SELECT id FROM processed_webhooks WHERE id = ?', [webhookId], 'get');
    if (existing) {
      processedWebhooks.set(webhookId, true); // Update cache
      logger.info(`[billing] Webhook ${webhookId} already processed (db), skipping.`);
      return res.json({ received: true });
    }
    
    // Record processing start
    await db.query('INSERT INTO processed_webhooks (id, source, event_type) VALUES (?, ?, ?)', [webhookId, 'dodo', eventType], 'run');
    processedWebhooks.set(webhookId, true);
  }

  try {
    switch (eventType) {
      // ── Subscription activated (checkout complete or renewal success) ──
      case 'subscription.active':
      case 'subscription.renewed': {
        const clientId = data.metadata?.clientId;
        const planId = data.metadata?.planId;
        const subscriptionId = data.subscription_id || data.id;
        const customerId = data.customer_id || data.customer?.customer_id;

        if (clientId) {
          const now = new Date().toISOString();
          await db.query(`
            UPDATE clients SET
              dodo_customer_id = ?,
              dodo_subscription_id = ?,
              plan = ?,
              subscription_status = 'active',
              plan_started_at = ?,
              grace_period_until = NULL,
              updated_at = ?
            WHERE id = ?
          `, [customerId, subscriptionId, planId || 'growth', now, now, clientId], 'run');

          // Record payment if available in payload
          const amount = data.total_amount || data.amount || 0;
          if (amount > 0) {
            const paymentId = require('crypto').randomUUID();
            await db.query(`
              INSERT INTO payments (id, client_id, dodo_payment_id, amount_cents, status, invoice_url, created_at)
              VALUES (?, ?, ?, ?, 'success', ?, ?)
            `, [paymentId, clientId, data.payment_id || webhookId, amount, data.invoice_url || null, now], 'run');
          }

          logger.info(`[billing] Client ${clientId} activated/renewed — plan: ${planId}, event: ${eventType}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: clientId, newValues: { plan: planId, subscription_status: 'active' } }); } catch (_) {}
        } else {
          // Fallback: look up by customer ID
          if (customerId) {
            const client = await db.query('SELECT id FROM clients WHERE dodo_customer_id = ?', [customerId], 'get');
            if (client) {
              await db.query("UPDATE clients SET subscription_status = 'active', updated_at = ? WHERE id = ?", [new Date().toISOString(), client.id], 'run');
              logger.info(`[billing] Payment succeeded for client ${client.id} (via customer lookup)`);
            }
          }
        }
        break;
      }

      // ── Subscription on hold (payment failed on renewal) ──
      case 'subscription.on_hold':
      case 'subscription.failed': {
        const customerId = data.customer_id || data.customer?.customer_id;
        const clientId = data.metadata?.clientId;

        const client = clientId
          ? await db.query('SELECT id FROM clients WHERE id = ?', [clientId], 'get')
          : customerId
            ? await db.query('SELECT id FROM clients WHERE dodo_customer_id = ?', [customerId], 'get')
            : null;

        if (client) {
          const gracePeriod = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days
          await db.query(
            "UPDATE clients SET subscription_status = 'past_due', grace_period_until = ?, updated_at = ? WHERE id = ?",
            [gracePeriod, new Date().toISOString(), client.id], 'run'
          );
          logger.warn(`[billing] Subscription ${eventType} for client ${client.id}. Grace period until ${gracePeriod}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: client.id, newValues: { subscription_status: 'past_due', grace_period_until: gracePeriod } }); } catch (_) {}
        }
        break;
      }

      // ── Subscription cancelled or expired ──
      case 'subscription.cancelled':
      case 'subscription.expired': {
        const customerId = data.customer_id || data.customer?.customer_id;
        const clientId = data.metadata?.clientId;

        const client = clientId
          ? await db.query('SELECT id FROM clients WHERE id = ?', [clientId], 'get')
          : customerId
            ? await db.query('SELECT id FROM clients WHERE dodo_customer_id = ?', [customerId], 'get')
            : null;

        if (client) {
          await db.query("UPDATE clients SET subscription_status = 'canceled', plan = 'canceled', updated_at = ? WHERE id = ?", [new Date().toISOString(), client.id], 'run');
          logger.info(`[billing] Subscription ${eventType} for client ${client.id}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: client.id, newValues: { subscription_status: 'canceled', plan: 'canceled' } }); } catch (_) {}
        }
        break;
      }

      // ── Plan changed (upgrade/downgrade) ──
      case 'subscription.plan_changed':
      case 'subscription.updated': {
        const customerId = data.customer_id || data.customer?.customer_id;
        const clientId = data.metadata?.clientId;
        const subscriptionId = data.subscription_id || data.id;
        const newPlanId = data.metadata?.planId;
        const status = data.status || 'active';

        const client = clientId
          ? await db.query('SELECT id FROM clients WHERE id = ?', [clientId], 'get')
          : customerId
            ? await db.query('SELECT id FROM clients WHERE dodo_customer_id = ?', [customerId], 'get')
            : null;

        if (client) {
          const updates = { subscription_status: status, dodo_subscription_id: subscriptionId };
          const now = new Date().toISOString();
          let sql = "UPDATE clients SET subscription_status = ?, dodo_subscription_id = ?, updated_at = ?";
          const params = [status, subscriptionId, now];

          if (newPlanId && PLANS[newPlanId]) {
            sql += ', plan = ?';
            params.push(newPlanId);
            updates.plan = newPlanId;
          }

          sql += ' WHERE id = ?';
          params.push(client.id);

          await db.query(sql, params, 'run');
          logger.info(`[billing] Subscription updated for client ${client.id} — status: ${status}`);
          try { logDataMutation(db, { action: 'client_updated', table: 'clients', recordId: client.id, newValues: updates }); } catch (_) {}
        }
        break;
      }

      default:
        logger.debug(`[billing] Unhandled webhook event: ${eventType}`);
    }
  } catch (err) {
    logger.error(`[billing] Webhook processing error (${eventType}):`, err.message);
  }

  res.json({ received: true });
});

// GET /billing/status — get current billing status
router.get('/status', requireAuth, async (req, res) => {
  const db = req.app.locals.db;
  const client = await db.query(
    'SELECT plan, subscription_status, dodo_customer_id, dodo_subscription_id, plan_started_at, grace_period_until FROM clients WHERE id = ?',
    [req.clientId],
    'get'
  );

  if (!client) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const invoices = await db.query(
    'SELECT dodo_payment_id, amount_cents, status, invoice_url, created_at FROM payments WHERE client_id = ? ORDER BY created_at DESC LIMIT 12',
    [req.clientId],
    'all'
  );

  res.json({
    plan: client.plan || 'trial',
    status: client.subscription_status || 'active',
    has_payment: !!client.dodo_customer_id,
    started_at: client.plan_started_at,
    grace_period_until: client.grace_period_until,
    invoices: invoices.map(i => ({
      id: i.dodo_payment_id,
      amount: i.amount_cents / 100,
      status: i.status,
      url: i.invoice_url,
      date: i.created_at
    }))
  });
});

module.exports = router;
