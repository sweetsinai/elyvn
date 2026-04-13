/**
 * Integration tests — Dodo Payments billing webhook flows
 *
 * Strategy:
 *   - SQLite in-memory via better-sqlite3 (real SQL, no mock DB)
 *   - standardwebhooks Webhook.verify() mocked — we control verification
 *   - supertest for HTTP layer
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!';
process.env.DODO_API_KEY = 'dodo_test_integration_fake';
process.env.DODO_WEBHOOK_SECRET = 'whsec_test_dodo_secret';

const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePayload(type, dataObj) {
  return {
    type,
    data: { ...dataObj },
  };
}

/** Standard Webhook headers for Dodo */
function dodoHeaders() {
  return {
    'webhook-id': `msg_test_${Math.random().toString(36).slice(2)}`,
    'webhook-signature': 'v1,dGVzdA==',
    'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
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
      dodo_customer_id TEXT,
      dodo_subscription_id TEXT,
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
    dodo_customer_id: 'cust_test_001',
    dodo_subscription_id: null,
    plan: 'trial',
    subscription_status: 'trialing',
    plan_started_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  db.prepare(`
    INSERT OR REPLACE INTO clients
      (id, owner_email, business_name, dodo_customer_id, dodo_subscription_id,
       plan, subscription_status, plan_started_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    client.id, client.owner_email, client.business_name,
    client.dodo_customer_id, client.dodo_subscription_id,
    client.plan, client.subscription_status,
    client.plan_started_at, client.updated_at
  );
  return client;
}

// ─── App factory ────────────────────────────────────────────────────────────

let mockVerify;

function buildApp(db, opts = {}) {
  // Mock standardwebhooks BEFORE requiring billing router
  mockVerify = jest.fn((body, headers) => {
    if (opts.rejectSignature) {
      throw new Error('Invalid signature');
    }
    return JSON.parse(typeof body === 'string' ? body : body.toString());
  });

  jest.mock('standardwebhooks', () => ({
    Webhook: jest.fn().mockImplementation(() => ({
      verify: mockVerify,
    })),
  }));

  jest.mock('../../utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  jest.mock('../../utils/auditLog', () => ({
    logAudit: jest.fn().mockResolvedValue(undefined),
    logDataMutation: jest.fn().mockResolvedValue(undefined),
  }));

  const billingRouter = require('../../routes/billing');

  const app = express();
  // Do NOT apply global express.json() — the webhook route uses express.raw()
  // and a global JSON parser would consume the body before express.raw() can.
  app.locals.db = db;
  app.use('/billing', billingRouter);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Billing integration — Dodo Payments webhook flows', () => {
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

  describe('Dodo webhook signature verification', () => {
    test('rejects request when signature verification fails (400)', async () => {
      jest.resetModules();
      const rejectDb = createTestDb();
      const rejectApp = buildApp(rejectDb, { rejectSignature: true });

      const payload = makePayload('subscription.active', { customer_id: 'cust_test_001' });
      const headers = dodoHeaders();

      const res = await request(rejectApp)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(400);
      rejectDb.close();
    });

    test('accepts request with valid webhook headers (200)', async () => {
      seedClient(db);

      const payload = makePayload('subscription.active', {
        metadata: { clientId: 'client-integration-1', planId: 'growth' },
        customer_id: 'cust_test_001',
        subscription_id: 'sub_new_001',
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('processes request without secret in non-production (dev fallback, 200)', async () => {
      // Remove the webhook secret to test dev fallback
      const origSecret = process.env.DODO_WEBHOOK_SECRET;
      delete process.env.DODO_WEBHOOK_SECRET;

      jest.resetModules();
      const devDb = createTestDb();
      seedClient(devDb);
      const devApp = buildApp(devDb);

      const payload = makePayload('subscription.active', {
        metadata: { clientId: 'client-integration-1', planId: 'growth' },
        customer_id: 'cust_test_001',
        subscription_id: 'sub_dev_001',
      });

      const res = await request(devApp)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        // No webhook headers — dev mode bypasses verification
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      process.env.DODO_WEBHOOK_SECRET = origSecret;
      devDb.close();
    });
  });

  // ── subscription.active — activates client ────────────────────────────────

  describe('subscription.active — activates client record', () => {
    test('updates plan and sets subscription_status to active', async () => {
      seedClient(db, { plan: 'trial', subscription_status: 'trialing' });

      const payload = makePayload('subscription.active', {
        metadata: { clientId: 'client-integration-1', planId: 'pro' },
        customer_id: 'cust_test_001',
        subscription_id: 'sub_new_001',
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      const row = db.prepare('SELECT * FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.plan).toBe('pro');
      expect(row.subscription_status).toBe('active');
      expect(row.dodo_subscription_id).toBe('sub_new_001');
    });

    test('falls back to customer lookup when clientId absent in metadata', async () => {
      seedClient(db);

      const payload = makePayload('subscription.active', {
        customer_id: 'cust_test_001',
        subscription_id: 'sub_fallback',
        metadata: {},
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.subscription_status).toBe('active');
    });

    test('no-ops gracefully when clientId and customer not found', async () => {
      const payload = makePayload('subscription.active', {
        customer_id: 'cust_orphan',
        subscription_id: 'sub_orphan',
        metadata: {},
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
    });
  });

  // ── subscription.renewed ──────────────────────────────────────────────────

  describe('subscription.renewed — extends access', () => {
    test('sets subscription_status to active on renewal', async () => {
      seedClient(db, { subscription_status: 'past_due', plan: 'growth' });

      const payload = makePayload('subscription.renewed', {
        metadata: { clientId: 'client-integration-1', planId: 'growth' },
        customer_id: 'cust_test_001',
        subscription_id: 'sub_renewed_001',
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.subscription_status).toBe('active');
    });
  });

  // ── subscription.on_hold / subscription.failed — marks past-due ────────

  describe('subscription.on_hold — marks account past-due', () => {
    test('sets subscription_status to past_due', async () => {
      seedClient(db, { subscription_status: 'active' });

      const payload = makePayload('subscription.on_hold', {
        customer_id: 'cust_test_001',
        metadata: { clientId: 'client-integration-1' },
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.subscription_status).toBe('past_due');
    });

    test('no-ops when dodo_customer_id not in DB', async () => {
      const payload = makePayload('subscription.on_hold', {
        customer_id: 'cust_unknown_999',
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
    });
  });

  describe('subscription.failed — marks account past-due', () => {
    test('sets subscription_status to past_due', async () => {
      seedClient(db, { subscription_status: 'active' });

      const payload = makePayload('subscription.failed', {
        customer_id: 'cust_test_001',
        metadata: { clientId: 'client-integration-1' },
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.subscription_status).toBe('past_due');
    });

    test('transitions from active to past_due (not active)', async () => {
      seedClient(db, { subscription_status: 'active' });

      const payload = makePayload('subscription.failed', {
        customer_id: 'cust_test_001',
        metadata: { clientId: 'client-integration-1' },
      });
      const headers = dodoHeaders();

      await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      const row = db.prepare('SELECT subscription_status FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.subscription_status).not.toBe('active');
    });
  });

  // ── subscription.cancelled / subscription.expired — cancels account ────

  describe('subscription.cancelled — cancels account', () => {
    test('sets plan and status to canceled', async () => {
      seedClient(db, { plan: 'pro', subscription_status: 'active' });

      const payload = makePayload('subscription.cancelled', {
        customer_id: 'cust_test_001',
        metadata: { clientId: 'client-integration-1' },
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT plan, subscription_status FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.plan).toBe('canceled');
      expect(row.subscription_status).toBe('canceled');
    });
  });

  describe('subscription.expired — expires account', () => {
    test('sets plan and status to canceled on expiry', async () => {
      seedClient(db, { plan: 'growth', subscription_status: 'active' });

      const payload = makePayload('subscription.expired', {
        customer_id: 'cust_test_001',
        metadata: { clientId: 'client-integration-1' },
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT plan, subscription_status FROM clients WHERE id = ?').get('client-integration-1');
      expect(row.plan).toBe('canceled');
      expect(row.subscription_status).toBe('canceled');
    });
  });

  // ── subscription.updated / subscription.plan_changed ──────────────────

  describe('subscription.updated — updates subscription', () => {
    test('sets subscription_status and dodo_subscription_id', async () => {
      seedClient(db);

      const payload = makePayload('subscription.updated', {
        subscription_id: 'sub_updated_001',
        customer_id: 'cust_test_001',
        metadata: { clientId: 'client-integration-1' },
        status: 'active',
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT subscription_status, dodo_subscription_id FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.subscription_status).toBe('active');
      expect(row.dodo_subscription_id).toBe('sub_updated_001');
    });

    test('no-ops when customer not found in DB', async () => {
      const payload = makePayload('subscription.updated', {
        subscription_id: 'sub_ghost',
        customer_id: 'cust_does_not_exist',
        metadata: {},
        status: 'active',
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
    });
  });

  describe('subscription.plan_changed — upgrades/downgrades plan', () => {
    test('updates plan when planId provided in metadata', async () => {
      seedClient(db, { plan: 'growth' });

      const payload = makePayload('subscription.plan_changed', {
        subscription_id: 'sub_changed_001',
        customer_id: 'cust_test_001',
        metadata: { clientId: 'client-integration-1', planId: 'elite' },
        status: 'active',
      });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      const row = db.prepare('SELECT plan, dodo_subscription_id FROM clients WHERE id = ?')
        .get('client-integration-1');
      expect(row.plan).toBe('elite');
      expect(row.dodo_subscription_id).toBe('sub_changed_001');
    });
  });

  // ── Unknown event types ──────────────────────────────────────────────────

  describe('unknown / unhandled event types', () => {
    const unknownTypes = [
      'payment.succeeded',
      'refund.created',
      'dispute.opened',
      'completely.made.up',
    ];

    test.each(unknownTypes)('handles %s gracefully with 200', async (type) => {
      const payload = makePayload(type, { id: 'irrelevant' });
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('empty payload body still returns 200', async () => {
      const headers = dodoHeaders();

      const res = await request(app)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('webhook-id', headers['webhook-id'])
        .set('webhook-signature', headers['webhook-signature'])
        .set('webhook-timestamp', headers['webhook-timestamp'])
        .send('{}');

      expect(res.status).toBe(200);
    });
  });

  // ── GET /billing/plans (sanity) ──────────────────────────────────────────

  describe('GET /billing/plans', () => {
    test('returns growth, pro, elite', async () => {
      const res = await request(app).get('/billing/plans');
      expect(res.status).toBe(200);
      const ids = res.body.plans.map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['growth', 'pro', 'elite']));
    });

    test('plan prices match Dodo product configuration', async () => {
      const res = await request(app).get('/billing/plans');
      const plans = res.body.plans;
      const growth = plans.find(p => p.id === 'growth');
      const pro = plans.find(p => p.id === 'pro');
      const elite = plans.find(p => p.id === 'elite');
      expect(growth.price).toBe(199);
      expect(pro.price).toBe(349);
      expect(elite.price).toBe(599);
    });
  });
});
