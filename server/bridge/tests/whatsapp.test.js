'use strict';

const request = require('supertest');
const express = require('express');
const { createHmac } = require('crypto');

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock the legacySms handlers that whatsapp.js re-uses
jest.mock('../routes/legacySms/handlers', () => ({
  handleInboundSMS: jest.fn().mockResolvedValue(undefined),
}));

// ─── Route under test ─────────────────────────────────────────────────────────

const whatsappRouter = require('../routes/whatsapp');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AUTH_TOKEN = 'test-twilio-auth-token-for-ci';

function buildTwilioSignature(authToken, url, params = {}) {
  const sortedKeys = Object.keys(params).sort();
  const sigStr = url + sortedKeys.map(k => k + params[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(sigStr, 'utf-8')).digest('base64');
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/webhooks/whatsapp', whatsappRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });

  if (db !== undefined) app.locals.db = db;
  return app;
}

// ─── Signature verification tests ─────────────────────────────────────────────

describe('POST /webhooks/whatsapp — signature verification', () => {
  const webhookUrl = 'http://localhost:3001/webhooks/whatsapp';

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.PORT = '3001';
    delete process.env.BASE_URL;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.NODE_ENV;
  });

  test('returns 403 when x-twilio-signature header is missing', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({ From: 'whatsapp:+14155550001', To: 'whatsapp:+14155550002', Body: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/missing signature/i);
  });

  test('returns 403 when signature is invalid', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('x-twilio-signature', 'bad_signature_value')
      .send({ From: 'whatsapp:+14155550001', To: 'whatsapp:+14155550002', Body: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invalid signature/i);
  });

  test('skips validation and returns 200 when TWILIO_AUTH_TOKEN not set (non-prod)', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({ From: 'whatsapp:+14155550001', To: 'whatsapp:+14155550002', Body: 'hi' });
    expect(res.status).toBe(200);
  });

  test('returns 403 in production when TWILIO_AUTH_TOKEN not set', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.NODE_ENV = 'production';
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({ From: 'whatsapp:+14155550001', To: 'whatsapp:+14155550002', Body: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not configured');
    delete process.env.NODE_ENV;
  });

  test('returns 200 with valid Twilio signature', async () => {
    const params = {
      From: 'whatsapp:+14155550001',
      To: 'whatsapp:+14155550002',
      Body: 'Hello',
    };
    const sig = buildTwilioSignature(AUTH_TOKEN, webhookUrl, params);
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('x-twilio-signature', sig)
      .send(params);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');
  });
});

// ─── Inbound message handling ─────────────────────────────────────────────────

describe('POST /webhooks/whatsapp — inbound message handling', () => {
  beforeEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    jest.clearAllMocks();
  });

  test('returns 200 TwiML response immediately', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({ From: 'whatsapp:+14155550001', To: 'whatsapp:+14155550002', Body: 'hi' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  test('returns 200 and calls handleInboundSMS with normalized phone numbers', async () => {
    const { handleInboundSMS } = require('../routes/legacySms/handlers');
    const db = { query: jest.fn() };
    const app = buildApp(db);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({
        From: 'whatsapp:+14155550001',
        To: 'whatsapp:+14155550002',
        Body: 'Hello there',
        MessageSid: 'SM123456',
      });
    expect(res.status).toBe(200);
    // Give setImmediate a tick to execute
    await new Promise(resolve => setImmediate(resolve));
    expect(handleInboundSMS).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        from: '+14155550001',
        to: '+14155550002',
        body: 'Hello there',
        messageId: 'SM123456',
      })
    );
  });

  test('handles missing From/To gracefully without crashing', async () => {
    const db = { query: jest.fn() };
    const app = buildApp(db);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({ Body: 'no from or to' });
    expect(res.status).toBe(200);
  });

  test('handles media messages (NumMedia > 0) without error', async () => {
    const db = { query: jest.fn() };
    const app = buildApp(db);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({
        From: 'whatsapp:+14155550001',
        To: 'whatsapp:+14155550002',
        Body: '',
        NumMedia: '2',
      });
    expect(res.status).toBe(200);
  });

  test('returns 200 even when db is not available', async () => {
    const app = buildApp(undefined);
    // No db set on app.locals
    const appNoDb = express();
    appNoDb.use(express.json());
    appNoDb.use(express.urlencoded({ extended: true }));
    appNoDb.use('/webhooks/whatsapp', whatsappRouter);
    const res = await request(appNoDb)
      .post('/webhooks/whatsapp')
      .send({ From: 'whatsapp:+14155550001', To: 'whatsapp:+14155550002', Body: 'hi' });
    expect(res.status).toBe(200);
  });

  test('handleInboundSMS error does not surface as HTTP error', async () => {
    const { handleInboundSMS } = require('../routes/legacySms/handlers');
    handleInboundSMS.mockRejectedValueOnce(new Error('SMS handler boom'));
    const db = { query: jest.fn() };
    const app = buildApp(db);
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .send({ From: 'whatsapp:+14155550001', To: 'whatsapp:+14155550002', Body: 'test' });
    expect(res.status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
  });

  test('strips whatsapp: prefix (case-insensitive) from phone numbers', async () => {
    const { handleInboundSMS } = require('../routes/legacySms/handlers');
    handleInboundSMS.mockResolvedValue(undefined);
    const db = { query: jest.fn() };
    const app = buildApp(db);
    await request(app)
      .post('/webhooks/whatsapp')
      .send({
        From: 'WhatsApp:+14155550001',
        To: 'WHATSAPP:+14155550002',
        Body: 'test',
      });
    await new Promise(resolve => setImmediate(resolve));
    expect(handleInboundSMS).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        from: '+14155550001',
        to: '+14155550002',
      })
    );
  });
});
