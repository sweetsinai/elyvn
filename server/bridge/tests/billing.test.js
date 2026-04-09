/**
 * Tests for routes/billing.js — Stripe billing plans, webhooks, status
 */

process.env.JWT_SECRET = 'test-jwt-secret-key-for-unit-tests';
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

describe('billing routes', () => {
  let app;
  let request;
  let createToken;
  let mockDb;

  function buildDb(overrides = {}) {
    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('SELECT id FROM clients WHERE stripe_customer_id') ||
            sql.includes('SELECT id, name, owner_email, password_hash')) {
          return {
            get: jest.fn(() => overrides.clientByStripe || null),
          };
        }
        if (sql.includes('SELECT plan, subscription_status')) {
          return {
            get: jest.fn(() => 'billingStatus' in overrides ? overrides.billingStatus : {
              plan: 'starter', subscription_status: 'active',
              stripe_customer_id: 'cus_123', stripe_subscription_id: 'sub_1',
              plan_started_at: '2026-01-01',
            }),
          };
        }
        if (sql.includes('UPDATE clients SET')) {
          return { run: jest.fn() };
        }
        return { get: jest.fn(() => null), run: jest.fn(), all: jest.fn(() => []) };
      }),
    };
    db.query = jest.fn((sql, params = [], mode = 'all') => {
      const stmt = db.prepare(sql);
      if (mode === 'get') return Promise.resolve(stmt.get(...(params || [])));
      if (mode === 'run') return Promise.resolve(stmt.run(...(params || [])));
      return Promise.resolve(stmt.all(...(params || [])));
    });
    return db;
  }

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
    jest.mock('../utils/auditLog', () => ({ logAudit: jest.fn() }));

    // Mock stripe module
    jest.mock('stripe', () => {
      return jest.fn(() => ({
        webhooks: {
          constructEvent: jest.fn((body, sig, secret) => {
            if (!sig) throw new Error('No signature');
            return JSON.parse(typeof body === 'string' ? body : body.toString());
          }),
        },
      }));
    });

    createToken = require('../routes/auth').createToken;
    const billingRouter = require('../routes/billing');

    const express = require('express');
    app = express();
    // Mirror production: capture rawBody via verify callback
    app.use(express.json({
      verify: (req, res, buf) => { req.rawBody = buf.toString(); },
    }));
    mockDb = buildDb();
    app.locals.db = mockDb;
    app.use('/billing', billingRouter);

    request = require('supertest');
  });

  // ── GET /billing/plans ──

  describe('GET /billing/plans', () => {
    test('returns plans', async () => {
      const res = await request(app).get('/billing/plans');
      expect(res.status).toBe(200);
      expect(res.body.plans.length).toBeGreaterThanOrEqual(3);
      const names = res.body.plans.map(p => p.id);
      expect(names).toEqual(expect.arrayContaining(['starter', 'growth', 'scale']));
    });

    test('scale plan shows Unlimited calls', async () => {
      const res = await request(app).get('/billing/plans');
      const scale = res.body.plans.find(p => p.id === 'scale');
      expect(scale.calls).toBe('Unlimited');
    });

    test('prices are in dollars not cents', async () => {
      const res = await request(app).get('/billing/plans');
      const starter = res.body.plans.find(p => p.id === 'starter');
      expect(starter.price).toBe(299);
    });
  });

  // ── POST /billing/webhook ──

  describe('POST /billing/webhook', () => {
    function webhookReq(eventType, dataObj, meta = {}) {
      const event = {
        type: eventType,
        data: { object: dataObj },
      };
      return request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event));
    }

    test('checkout.session.completed updates client plan', async () => {
      const dbWithClient = buildDb({
        clientByStripe: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('checkout.session.completed', {
        client_reference_id: 'client-1',
        customer: 'cus_123',
        subscription: 'sub_456',
        metadata: { planId: 'growth' },
      });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      // Verify UPDATE was called
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c => c[0].includes('UPDATE clients SET'));
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('invoice.payment_failed marks as past_due', async () => {
      const dbWithClient = buildDb({
        clientByStripe: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('invoice.payment_failed', {
        customer: 'cus_123',
      });

      expect(res.status).toBe(200);
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c =>
        c[0].includes('past_due')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('customer.subscription.deleted marks as canceled', async () => {
      const dbWithClient = buildDb({
        clientByStripe: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('customer.subscription.deleted', {
        customer: 'cus_123',
      });

      expect(res.status).toBe(200);
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c =>
        c[0].includes('canceled')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('missing signature in production returns error', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

      // Need fresh module load with production env
      jest.resetModules();
      jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
      jest.mock('../utils/auditLog', () => ({ logAudit: jest.fn() }));
      jest.mock('stripe', () => jest.fn(() => ({
        webhooks: {
          constructEvent: jest.fn(() => { throw new Error('No signature'); }),
        },
      })));

      const express = require('express');
      const prodApp = express();
      prodApp.use(express.json());
      prodApp.locals.db = buildDb({ clientByStripe: { id: 'c1' } });
      prodApp.use('/billing', require('../routes/billing'));

      const res = await request(prodApp)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'bad_sig')
        .send('{}');

      expect(res.status).toBe(400);

      process.env.NODE_ENV = origEnv;
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    });
  });

  // ── GET /billing/status ──

  describe('GET /billing/status', () => {
    test('returns plan info for authenticated user', async () => {
      const token = createToken({ clientId: 'client-1', email: 'a@b.com' });

      const res = await request(app)
        .get('/billing/status')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.plan).toBe('starter');
      expect(res.body.status).toBe('active');
      expect(res.body.has_payment).toBe(true);
    });

    test('no token returns 401', async () => {
      const res = await request(app).get('/billing/status');
      expect(res.status).toBe(401);
    });

    test('account not found returns 404', async () => {
      app.locals.db = buildDb({ billingStatus: null });
      const token = createToken({ clientId: 'nonexistent', email: 'a@b.com' });

      const res = await request(app)
        .get('/billing/status')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});
