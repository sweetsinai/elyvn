'use strict';

const request = require('supertest');
const express = require('express');
const { createHmac } = require('crypto');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/leadMemory', () => ({
  getLeadMemory: jest.fn(() => null),
}));

jest.mock('../utils/brain', () => ({
  think: jest.fn().mockResolvedValue(null),
}));

jest.mock('../utils/actionExecutor', () => ({
  executeActions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue(undefined),
}));

// ─── Route under test ─────────────────────────────────────────────────────────

const socialRouter = require('../routes/social');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(db, opts = {}) {
  const app = express();
  // Use raw body capture so signature verification can work
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/webhooks/social', socialRouter);

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });

  app.locals.db = db || null;
  return app;
}

function makeSignature(secret, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
}

const APP_SECRET = 'test-meta-app-secret';
const VERIFY_TOKEN = 'test-meta-verify-token';

// ─── GET /webhooks/social — Meta verification challenge ───────────────────────

describe('GET /webhooks/social (Meta verification)', () => {
  beforeEach(() => {
    process.env.META_VERIFY_TOKEN = VERIFY_TOKEN;
    delete process.env.META_APP_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    delete process.env.META_VERIFY_TOKEN;
  });

  test('returns 403 when META_VERIFY_TOKEN not configured', async () => {
    delete process.env.META_VERIFY_TOKEN;
    const app = buildApp(null);
    const res = await request(app)
      .get('/webhooks/social')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'any', 'hub.challenge': '12345' });
    expect(res.status).toBe(403);
  });

  test('returns 200 and echoes challenge when token matches', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .get('/webhooks/social')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('abc123');
  });

  test('returns 403 when token does not match', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .get('/webhooks/social')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'abc123' });
    expect(res.status).toBe(403);
  });

  test('returns 403 when mode is not subscribe', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .get('/webhooks/social')
      .query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' });
    expect(res.status).toBe(403);
  });
});

// ─── POST /webhooks/social — webhook signature verification ───────────────────

describe('POST /webhooks/social — signature verification', () => {
  beforeEach(() => {
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.META_APP_SECRET;
    delete process.env.NODE_ENV;
  });

  test('returns 403 when x-hub-signature-256 header is missing', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/social')
      .send({ object: 'page', entry: [] });
    expect(res.status).toBe(403);
  });

  test('returns 403 when signature is invalid', async () => {
    const app = buildApp(null);
    const body = { object: 'page', entry: [] };
    const res = await request(app)
      .post('/webhooks/social')
      .set('x-hub-signature-256', 'sha256=bad_signature')
      .send(body);
    expect(res.status).toBe(403);
  });

  test('returns 200 when signature is valid (no META_APP_SECRET in non-prod)', async () => {
    delete process.env.META_APP_SECRET;
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/social')
      .send({ object: 'page', entry: [] });
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
  });

  test('returns 200 with valid HMAC signature', async () => {
    const body = JSON.stringify({ object: 'page', entry: [] });
    const sig = makeSignature(APP_SECRET, body);
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/social')
      .set('x-hub-signature-256', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
  });
});

// ─── POST /webhooks/social — inbound message handling ────────────────────────

describe('POST /webhooks/social — inbound messages', () => {
  beforeEach(() => {
    delete process.env.META_APP_SECRET;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  function makeDb(client = null) {
    return {
      query: jest.fn(async (sql, params, mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (mode === 'run') return { changes: 1 };
        if (mode === 'get' && s.includes('FROM clients')) return client;
        if (mode === 'get' && s.includes('FROM leads')) return null;
        if (mode === 'get' && s.includes('COUNT(*)')) return { c: 0 };
        return null;
      }),
    };
  }

  const messengerPayload = {
    object: 'page',
    entry: [{
      id: 'page-123',
      messaging: [{
        sender: { id: 'user-456' },
        recipient: { id: 'page-123' },
        message: { text: 'Hello from Messenger' },
      }],
    }],
  };

  const instagramPayload = {
    object: 'instagram',
    entry: [{
      id: 'ig-page-123',
      messaging: [{
        sender: { id: 'ig-user-789' },
        message: { text: 'Hello from Instagram' },
      }],
    }],
  };

  test('returns 200 immediately regardless of db state', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/social')
      .send({ object: 'page', entry: [] });
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
  });

  test('returns 200 for valid Messenger webhook payload', async () => {
    const db = makeDb({ id: 'client-1', business_name: 'Acme', telegram_chat_id: null });
    const app = buildApp(db);
    const res = await request(app)
      .post('/webhooks/social')
      .send(messengerPayload);
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
  });

  test('returns 200 for valid Instagram webhook payload', async () => {
    const db = makeDb({ id: 'client-1', business_name: 'Acme', telegram_chat_id: null });
    const app = buildApp(db);
    const res = await request(app)
      .post('/webhooks/social')
      .send(instagramPayload);
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
  });

  test('returns 200 for payload with missing text (no-op)', async () => {
    const db = makeDb(null);
    const app = buildApp(db);
    const payload = {
      object: 'page',
      entry: [{
        id: 'page-123',
        messaging: [{ sender: { id: 'user-456' }, message: {} }],
      }],
    };
    const res = await request(app)
      .post('/webhooks/social')
      .send(payload);
    expect(res.status).toBe(200);
  });

  test('returns 200 and does not crash when entry is missing', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/social')
      .send({ object: 'page' });
    expect(res.status).toBe(200);
  });

  test('returns 200 when db is not set (no app.locals.db)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/webhooks/social', socialRouter);
    // No app.locals.db set — simulates startup condition
    const res = await request(app)
      .post('/webhooks/social')
      .send({ object: 'page', entry: [] });
    expect(res.status).toBe(200);
  });

  test('db error during lead creation does not crash webhook response', async () => {
    const db = {
      query: jest.fn(async (sql, params, mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (mode === 'get' && s.includes('FROM clients')) {
          return { id: 'client-1', business_name: 'Acme', telegram_chat_id: null };
        }
        if (mode === 'run') throw new Error('DB write failure');
        return null;
      }),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/webhooks/social')
      .send(messengerPayload);
    // Webhook always returns 200 fast, DB errors happen async
    expect(res.status).toBe(200);
  });

  test('production mode blocks request when META_APP_SECRET missing and no signature', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.META_APP_SECRET;
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/social')
      .send({ object: 'page', entry: [] });
    // In production without app secret, the middleware allows through (no secret = no validation)
    // Actually re-reading the code: if !appSecret in production => 403
    expect(res.status).toBe(403);
    delete process.env.NODE_ENV;
  });
});
