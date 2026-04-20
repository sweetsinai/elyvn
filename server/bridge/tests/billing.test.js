/**
 * Tests for routes/billing.js — Dodo Payments billing plans, webhooks, status
 */

process.env.JWT_SECRET = 'test-jwt-secret-key-for-unit-tests';
process.env.NODE_ENV = 'test';
process.env.DODO_API_KEY = 'dodo_test_fake';
process.env.DODO_WEBHOOK_SECRET = 'whsec_test_dodo_secret';

describe('billing routes', () => {
  let app;
  let request;
  let createToken;
  let mockDb;

  function buildDb(overrides = {}) {
    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('SELECT id FROM clients WHERE dodo_customer_id') ||
            sql.includes('SELECT id FROM clients WHERE id') ||
            sql.includes('SELECT id, name, owner_email, password_hash')) {
          return {
            get: jest.fn(() => overrides.clientByDodo || null),
          };
        }
        if (sql.includes('SELECT plan, subscription_status')) {
          return {
            get: jest.fn(() => 'billingStatus' in overrides ? overrides.billingStatus : {
              plan: 'growth', subscription_status: 'active',
              dodo_customer_id: 'cust_123', dodo_subscription_id: 'sub_1',
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
    jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
    jest.mock('../utils/auditLog', () => ({ logAudit: jest.fn(), logDataMutation: jest.fn() }));

    // Mock standardwebhooks — verify returns parsed JSON in test mode
    jest.mock('standardwebhooks', () => ({
      Webhook: jest.fn().mockImplementation(() => ({
        verify: jest.fn((body, headers) => {
          if (!headers['webhook-id'] || !headers['webhook-signature'] || !headers['webhook-timestamp']) {
            throw new Error('Missing required headers');
          }
          // In unit tests, just parse and return the body
          return JSON.parse(typeof body === 'string' ? body : body.toString());
        }),
      })),
    }));

    createToken = require('../routes/auth').createToken;
    const billingRouter = require('../routes/billing');

    const express = require('express');
    app = express();
    // Do NOT apply global express.json() — the webhook route uses express.raw()
    // and a global JSON parser would consume the body before express.raw() can.
    // GET routes (/plans, /status) don't need body parsing.
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
      expect(res.body.plans.length).toBe(4);
      const names = res.body.plans.map(p => p.id);
      expect(names).toEqual(expect.arrayContaining(['trial', 'growth', 'pro', 'elite']));
    });

    test('elite plan shows Unlimited calls', async () => {
      const res = await request(app).get('/billing/plans');
      const elite = res.body.plans.find(p => p.id === 'elite');
      expect(elite.calls).toBe('Unlimited');
    });

    test('growth price is $199', async () => {
      const res = await request(app).get('/billing/plans');
      const growth = res.body.plans.find(p => p.id === 'growth');
      expect(growth.price).toBe(199);
    });

    test('pro price is $349', async () => {
      const res = await request(app).get('/billing/plans');
      const pro = res.body.plans.find(p => p.id === 'pro');
      expect(pro.price).toBe(349);
    });

    test('elite price is $599', async () => {
      const res = await request(app).get('/billing/plans');
      const elite = res.body.plans.find(p => p.id === 'elite');
      expect(elite.price).toBe(599);
    });
  });

  // ── POST /billing/webhook ──

  describe('POST /billing/webhook', () => {
    function webhookReq(eventType, dataObj, meta = {}) {
      const payload = {
        type: eventType,
        data: { ...dataObj },
      };
      return request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', 'msg_test_123')
        .set('webhook-signature', 'v1,valid_sig_placeholder')
        .set('webhook-timestamp', String(Math.floor(Date.now() / 1000)))
        .send(JSON.stringify(payload));
    }

    test('subscription.active updates client plan', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.active', {
        metadata: { clientId: 'client-1', planId: 'pro' },
        customer_id: 'cust_123',
        subscription_id: 'sub_456',
      });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      // Verify UPDATE was called
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c => c[0].includes('UPDATE clients SET'));
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('subscription.on_hold marks as past_due', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.on_hold', {
        customer_id: 'cust_123',
        metadata: { clientId: 'client-1' },
      });

      expect(res.status).toBe(200);
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c =>
        c[0].includes('past_due')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('subscription.failed marks as past_due', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.failed', {
        customer_id: 'cust_123',
        metadata: { clientId: 'client-1' },
      });

      expect(res.status).toBe(200);
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c =>
        c[0].includes('past_due')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('subscription.cancelled marks as canceled', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.cancelled', {
        customer_id: 'cust_123',
        metadata: { clientId: 'client-1' },
      });

      expect(res.status).toBe(200);
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c =>
        c[0].includes('canceled')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('subscription.expired marks as canceled', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.expired', {
        customer_id: 'cust_123',
        metadata: { clientId: 'client-1' },
      });

      expect(res.status).toBe(200);
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c =>
        c[0].includes('canceled')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('subscription.renewed activates subscription', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.renewed', {
        metadata: { clientId: 'client-1', planId: 'growth' },
        customer_id: 'cust_123',
        subscription_id: 'sub_renewed_1',
      });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      const updateCalls = dbWithClient.prepare.mock.calls.filter(c => c[0].includes('UPDATE clients SET'));
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test('subscription.updated updates subscription status', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.updated', {
        customer_id: 'cust_123',
        subscription_id: 'sub_upd_1',
        metadata: { clientId: 'client-1', planId: 'pro' },
        status: 'active',
      });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('subscription.plan_changed updates plan', async () => {
      const dbWithClient = buildDb({
        clientByDodo: { id: 'client-1' },
      });
      app.locals.db = dbWithClient;

      const res = await webhookReq('subscription.plan_changed', {
        customer_id: 'cust_123',
        subscription_id: 'sub_changed_1',
        metadata: { clientId: 'client-1', planId: 'elite' },
        status: 'active',
      });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('webhook signature verification failure returns 400', async () => {
      // Reset modules to get a fresh mock that throws
      jest.resetModules();
      jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
      jest.mock('../utils/auditLog', () => ({ logAudit: jest.fn(), logDataMutation: jest.fn() }));
      jest.mock('standardwebhooks', () => ({
        Webhook: jest.fn().mockImplementation(() => ({
          verify: jest.fn(() => { throw new Error('Invalid signature'); }),
        })),
      }));

      const express = require('express');
      const failApp = express();
      failApp.locals.db = buildDb({ clientByDodo: { id: 'c1' } });
      failApp.use('/billing', require('../routes/billing'));

      const res = await request(failApp)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', 'msg_bad')
        .set('webhook-signature', 'v1,invalid')
        .set('webhook-timestamp', '9999999')
        .send('{}');

      expect(res.status).toBe(400);
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
      expect(res.body.plan).toBe('growth');
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
