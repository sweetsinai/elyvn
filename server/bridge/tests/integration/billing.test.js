/**
 * Integration tests — Stripe billing webhook flows
 *
 * Strategy:
 *   - SQLite in-memory via better-sqlite3 (real SQL, no mock DB)
 *   - Stripe SDK fully mocked — we control constructEvent output
 *   - supertest for HTTP layer
 *   - HMAC signature computed manually for valid-path tests
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!';
process.env.STRIPE_SECRET_KEY = 'sk_test_integration_fake';

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_WEBHOOK_SECRET = 'whsec_test_integration_secret';

/**
 * Build a Stripe-like signed payload string and the matching signature header.
 * Stripe computes: HMAC-SHA256( "t=<ts>,v1=<hash>" ) over "t.<ts>.<payload>"
 */
function stripeSign(payload) {
  const ts = Math.floor(Date.now() / 1000);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signed = `${ts}.${body}`;
  const hmac = crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(signed).digest('hex');
  return { body, sig: `t=${ts},v1=${hmac}` };
}

function makeEvent(type, dataObj) {
  return {
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    type,
    data: { object: dataObj },
  };
}

// ─── In-memory SQLite setup ──────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      owner_email TEXT,
      business_name TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'trial',
      subscription_status TEXT DEFAULT 'trialing',
      plan_started_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      action TEXT,
      table_name TEXT,
      record_id TEXT,
      new_values TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Wrap with a db.query interface matching the app's pattern
  db.query = function query(sql, params = [], mode = 'all') {
    const stmt = db.prepare(sql);
    if (mode === 'get') return Promise.resolve(stmt.get(...params));
    if (mode === 'run') return Promise.resolve(stmt.run(...params));
    return Promise.resolve(stmt.all(...params));
  };

  return db;
}

function seedClient(db, overrides = {}) {
  const client = {
    id: 'client-integration-1',
    owner_email: 'owner@test.com',
    business_name: 'Test Biz',
    stripe_customer_id: 'cus_test_001',
    stripe_subscription_id: null,
    plan: 'trial',
    subscription_status: 'trialing',
    plan_started_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  db.prepare(`
    INSERT OR REPLACE INTO clients
      (id, owner_email, business_name, stripe_customer_id, stripe_subscription_id,
       plan, subscription_status, plan_started_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    client.id, client.owner_email, client.business_name,
    client.stripe_customer_id, client.stripe_subscription_id,
    client.plan, client.subscription_status,
    client.plan_started_at, client.updated_at
  );
  return client;
}

// ─── App factory ────────────────────────────────────────────────────────────

function buildApp(db) {
  // Mock stripe BEFORE requiring billing router
  jest.mock('stripe', () => {
    // Must use require() inside factory — jest.mock hoists and bans outer-scope refs
    const mockCrypto = require('crypto');
    return jest.fn().mockImplementation(() => ({
      webhooks: {
        constructEvent: jest.fn((rawBody, sig, secret) => {
          // Replicate Stripe's timing-attack-safe signature check
          if (!sig || !secret) throw new Error('No webhook secret or sig');
          const body = typeof rawBody === 'string' ? rawBody : rawBody.toString();
          // Parse t= and v1= from sig header
          const parts = Object.fromEntries(sig.split(',').map(p => p.split('=')));
          const ts = parts.t;
          if (!ts) throw new Error('Invalid signature format');
          const expected = mockCrypto
            .createHmac('sha256', secret)
            .update(`${ts}.${body}`)
            .digest('hex');
          const provided = Buffer.from(parts.v1 || '', 'hex');
          const exp = Buffer.from(expected, 'hex');
          if (provided.length !== exp.length || !mockCrypto.timingSafeEqual(provided, exp)) {
            throw new Error('No signatures found matching the expected signature for payload');
          }
          return JSON.parse(body);
        }),
      },
      customers: { create: jest.fn() },
      checkout: { sessions: { create: jest.fn() } },
    }));
  });

  jest.mock('../../utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  jest.mock('../../utils/auditLog', () => ({
    logAudit: jest.fn().mockResolvedValue(undefined),
    logDataMutation: jest.fn().mockResolvedValue(undefined),
  }));

  const billingRouter = require('../../routes/billing');

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString();
      },
    })
  );
  app.locals.db = db;
  app.use('/billing', billingRouter);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Billing integration — Stripe webhook flows', () => {
  let db;
  let app;

  beforeEach(() => {
    jest.resetModules();
    db = createTestDb();
    app = buildApp(db);
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
  });

  // ── Signature verification ───────────────────────────────────────────────

  describe('Stripe webhook signature verification', () => {
    test('rejects request with missing signature in production (400)', async () => {
      // The route only enforces no-sig rejection in NODE_ENV=production.
      // In test/dev with secret set but no sig, it falls back to raw-parse mode.
      // This test validates the production enforcement path.
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      // Reload modules with production env
      jest.resetModules();
      const prodApp = buildApp(createTestDb());

      const event = makeEvent('invoice.payment_succeeded', { customer: 'cus_test_001' });
      const res = await request(prodApp)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        // No stripe-signature header
        .send(JSON.stringify(event));

      // No sig + secret set + production → constructEvent not called → falls to
      // else branch → res.status(400) "Webhook signature required"
      expect(res.status).toBe(400);

      process.env.NODE_ENV = origEnv;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    });

    test('allows request with no signature in non-production (dev fallback, 200)', async () => {
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
      seedClient(db);

      const event = makeEvent('invoice.payment_succeeded', { customer: 'cus_test_001' });
      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        // No stripe-signature — dev/test mode bypasses verification
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      delete process.env.STRIPE_WEBHOOK_SECRET;
    });

    test('rejects request with tampered signature (400)', async () => {
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      const event = makeEvent('invoice.payment_succeeded', { customer: 'cus_test_001' });
      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 't=9999999,v1=deadbeefdeadbeef')
        .send(JSON.stringify(event));

      expect(res.status).toBe(400);

      delete process.env.STRIPE_WEBHOOK_SECRET;
    });

    test('accepts request with valid HMAC signature (200)', async () => {
      process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
      seedClient(db);

      const event = makeEvent('invoice.payment_succeeded', { customer: 'cus_test_001' });
      const { body, sig } = stripeSign(event);

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', sig)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      delete process.env.STRIPE_WEBHOOK_SECRET;
    });
  });

  // ── subscription.created (checkout.session.completed) ───────────────────

  describe('checkout.session.completed — creates/activates client record', () => {
    test('updates plan and sets subscription_status to active', async () => {
      seedClient(db, { plan: 'trial', subscription_status: 'trialing' });

      const event = makeEvent('checkout.session.completed', {
        client_reference_id: 'client-integration-1',
        customer: 'cus_test_001',
        subscription: 'sub_new_001',
        metadata: { clientId: 'client-integration-1', planId: 'growth' },
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      const row = db.prepare('SELECT * FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.plan).toBe('growth');
      expect(row.subscription_status).toBe('active');
      expect(row.stripe_subscription_id).toBe('sub_new_001');
    });

    test('falls back to metadata.clientId when client_reference_id absent', async () => {
      seedClient(db);

      const event = makeEvent('checkout.session.completed', {
        customer: 'cus_test_001',
        subscription: 'sub_fallback',
        metadata: { clientId: 'client-integration-1', planId: 'starter' },
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT plan FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.plan).toBe('starter');
    });

    test('no-ops gracefully when clientId is absent', async () => {
      const event = makeEvent('checkout.session.completed', {
        customer: 'cus_orphan',
        subscription: 'sub_orphan',
        metadata: {},
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      // Should still return 200 — graceful no-op
      expect(res.status).toBe(200);
    });
  });

  // ── customer.subscription.updated — updates plan status ─────────────────

  describe('customer.subscription.updated — updates plan', () => {
    test('sets subscription_status from sub.status', async () => {
      seedClient(db);

      const event = makeEvent('customer.subscription.updated', {
        id: 'sub_updated_001',
        customer: 'cus_test_001',
        status: 'active',
        cancel_at_period_end: false,
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status, stripe_subscription_id FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.subscription_status).toBe('active');
      expect(row.stripe_subscription_id).toBe('sub_updated_001');
    });

    test('sets status to "canceling" when cancel_at_period_end is true', async () => {
      seedClient(db);

      const event = makeEvent('customer.subscription.updated', {
        id: 'sub_cancel_001',
        customer: 'cus_test_001',
        status: 'active',
        cancel_at_period_end: true,
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.subscription_status).toBe('canceling');
    });

    test('no-ops when customer not found in DB', async () => {
      const event = makeEvent('customer.subscription.updated', {
        id: 'sub_ghost',
        customer: 'cus_does_not_exist',
        status: 'active',
        cancel_at_period_end: false,
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
    });
  });

  // ── invoice.payment_succeeded — extends access ───────────────────────────

  describe('invoice.payment_succeeded — extends access', () => {
    test('sets subscription_status to active', async () => {
      seedClient(db, { subscription_status: 'past_due' });

      const event = makeEvent('invoice.payment_succeeded', {
        customer: 'cus_test_001',
        amount_paid: 29900,
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.subscription_status).toBe('active');
    });

    test('no-ops when stripe_customer_id not in DB', async () => {
      const event = makeEvent('invoice.payment_succeeded', {
        customer: 'cus_unknown_999',
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      // No row exists for this customer — should not throw
    });
  });

  // ── invoice.payment_failed — marks account past-due ──────────────────────

  describe('invoice.payment_failed — marks account past-due', () => {
    test('sets subscription_status to past_due', async () => {
      seedClient(db, { subscription_status: 'active' });

      const event = makeEvent('invoice.payment_failed', {
        customer: 'cus_test_001',
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.subscription_status).toBe('past_due');
    });

    test('transitions from active → past_due (not active)', async () => {
      seedClient(db, { subscription_status: 'active' });

      const event = makeEvent('invoice.payment_failed', { customer: 'cus_test_001' });
      await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.subscription_status).not.toBe('active');
    });
  });

  // ── customer.subscription.deleted ───────────────────────────────────────

  describe('customer.subscription.deleted — cancels account', () => {
    test('sets plan and status to canceled', async () => {
      seedClient(db, { plan: 'growth', subscription_status: 'active' });

      const event = makeEvent('customer.subscription.deleted', {
        id: 'sub_deleted_001',
        customer: 'cus_test_001',
      });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT plan, subscription_status FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.plan).toBe('canceled');
      expect(row.subscription_status).toBe('canceled');
    });
  });

  // ── Unknown event types ──────────────────────────────────────────────────

  describe('unknown / unhandled event types', () => {
    const unknownTypes = [
      'charge.succeeded',
      'payment_method.attached',
      'price.created',
      'product.updated',
      'completely.made.up',
    ];

    test.each(unknownTypes)('handles %s gracefully with 200', async (type) => {
      const event = makeEvent(type, { id: 'irrelevant' });

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));

      // Must NOT crash; must return 200 with received:true
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('empty payload body still returns 200', async () => {
      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(200);
    });
  });

  // ── GET /billing/plans (sanity) ──────────────────────────────────────────

  describe('GET /billing/plans', () => {
    test('returns starter, growth, scale', async () => {
      const res = await request(app).get('/billing/plans');
      expect(res.status).toBe(200);
      const ids = res.body.plans.map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['starter', 'growth', 'scale']));
    });
  });
});
