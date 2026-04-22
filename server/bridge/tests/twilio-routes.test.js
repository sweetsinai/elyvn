/**
 * Tests for routes/twilio.js — inbound SMS webhook handler
 */

process.env.TWILIO_AUTH_TOKEN = '';
process.env.ANTHROPIC_API_KEY = 'test-key';

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ text: 'AI reply here' }],
      }),
    },
  }));
});
jest.mock('../utils/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue({ success: true, messageId: 'sm_123' }),
}));
jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../utils/calcom', () => ({ cancelBooking: jest.fn() }));
jest.mock('../utils/config', () => ({
  ai: { model: 'claude-sonnet-4-20250514', maxTokens: 300 },
}));
jest.mock('../utils/validators', () => ({ isValidUUID: jest.fn(() => true) }));
jest.mock('../utils/resilience', () => ({
  withTimeout: jest.fn((promise) => promise),
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../utils/nicheTemplates', () => ({
  generateSystemPrompt: jest.fn(() => 'You are a helpful assistant.'),
}));
jest.mock('../utils/kbCache', () => ({
  loadKnowledgeBase: jest.fn().mockResolvedValue('KB content'),
}));

describe('twilio routes', () => {
  let app;
  let request;
  let mockDb;
  let sendSMS;
  let telegram;

  function buildDb(overrides = {}) {
    const insertedOptOuts = [];
    const deletedOptOuts = [];
    const db = {
      insertedOptOuts,
      deletedOptOuts,
      query(sql, params = [], mode = 'all') {
        try {
          const stmt = this.prepare(sql);
          let result;
          if (mode === 'get') result = stmt.get(...params);
          else if (mode === 'run') result = stmt.run(...params);
          else result = stmt.all(...params);
          return Promise.resolve(result);
        } catch (err) {
          return Promise.reject(err);
        }
      },
      prepare: jest.fn((sql) => {
        if (sql.includes('SELECT id FROM messages WHERE message_sid')) {
          return { get: jest.fn(() => overrides.duplicateMsg ? { id: 'existing' } : null) };
        }
        if (sql.includes('FROM clients WHERE phone_number')) {
          return {
            get: jest.fn(() => overrides.client || {
              id: 'client-1', name: 'TestBiz', business_name: 'TestBiz',
              phone_number: '+18005551234', twilio_phone: '+18005551234', telnyx_phone: null,
              is_active: 1, telegram_chat_id: null,
              notification_mode: 'instant',
              calcom_booking_link: 'https://cal.com/test',
            }),
          };
        }
        if (sql.includes('sms_opt_outs') && (sql.includes('INSERT'))) {
          return { run: jest.fn((...args) => insertedOptOuts.push(args)) };
        }
        if (sql.includes('DELETE FROM sms_opt_outs')) {
          return { run: jest.fn((...args) => deletedOptOuts.push(args)) };
        }
        if (sql.includes('SELECT * FROM leads WHERE phone')) {
          return { get: jest.fn(() => overrides.lead || null) };
        }
        if (sql.includes('INSERT INTO leads')) {
          return { run: jest.fn() };
        }
        if (sql.includes('INSERT INTO messages')) {
          return { run: jest.fn() };
        }
        if (sql.includes('SELECT direction, body')) {
          return { all: jest.fn(() => []) };
        }
        if (sql.includes('UPDATE leads')) {
          return { run: jest.fn() };
        }
        return { get: jest.fn(() => null), run: jest.fn(), all: jest.fn(() => []) };
      }),
    };
    return db;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_AUTH_TOKEN = '';

    sendSMS = require('../utils/sms').sendSMS;
    telegram = require('../utils/telegram');

    const express = require('express');
    app = express();
    mockDb = buildDb();
    app.locals.db = mockDb;

    const twilioRouter = require('../routes/twilio');
    app.use('/webhooks/twilio', twilioRouter);

    request = require('supertest');
  });

  test('valid inbound SMS returns 200 XML', async () => {
    const res = await request(app)
      .post('/webhooks/twilio')
      .type('form')
      .send({ From: '+15551112222', To: '+18005551234', Body: 'Hello', MessageSid: 'SM001' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');
  });

  test('opt-out keyword STOP records opt-out', async () => {
    const db = buildDb();
    app.locals.db = db;

    await request(app)
      .post('/webhooks/twilio')
      .type('form')
      .send({ From: '+15551112222', To: '+18005551234', Body: 'STOP', MessageSid: 'SM002' });

    // Wait for setImmediate processing
    await new Promise(r => setTimeout(r, 100));
    expect(db.insertedOptOuts.length).toBe(1);
  });

  test('opt-in keyword START removes opt-out', async () => {
    const db = buildDb();
    app.locals.db = db;

    await request(app)
      .post('/webhooks/twilio')
      .type('form')
      .send({ From: '+15551112222', To: '+18005551234', Body: 'START', MessageSid: 'SM003' });

    await new Promise(r => setTimeout(r, 100));
    expect(db.deletedOptOuts.length).toBe(1);
  });

  test('duplicate message_sid is idempotent', async () => {
    app.locals.db = buildDb({ duplicateMsg: true });

    const res = await request(app)
      .post('/webhooks/twilio')
      .type('form')
      .send({ From: '+15551112222', To: '+18005551234', Body: 'Hello again', MessageSid: 'SM_DUP' });

    expect(res.status).toBe(200);
    // AI should not be called for duplicate
    await new Promise(r => setTimeout(r, 100));
    expect(sendSMS).not.toHaveBeenCalled();
  });

  test('invalid signature returns 403 when auth token set', async () => {
    // The validateTwilioSignature function checks TWILIO_AUTH_TOKEN at call time.
    // Set it so signature validation is enforced.
    process.env.TWILIO_AUTH_TOKEN = 'real-secret-token';

    // The module reads TWILIO_AUTH_TOKEN at call time (not import time),
    // so we can just set the env and reuse the existing app.
    const res = await request(app)
      .post('/webhooks/twilio')
      .type('form')
      // HMAC-SHA1 produces 20 bytes -> 28-char base64. Send wrong sig of same length.
      .set('x-twilio-signature', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      .send({ From: '+15551112222', To: '+18005551234', Body: 'Hi', MessageSid: 'SM_BAD' });

    // timingSafeEqual throws RangeError when lengths differ, which makes
    // validateTwilioSignature return false -> 403
    expect(res.status).toBe(403);
  });

  test('client not found for to_number does not call AI', async () => {
    app.locals.db = buildDb({ client: null });

    // Null client means the prepare for clients returns null
    app.locals.db.prepare = jest.fn((sql) => {
      if (sql.includes('SELECT id FROM messages WHERE message_sid')) {
        return { get: jest.fn(() => null) };
      }
      if (sql.includes('SELECT * FROM clients WHERE phone_number')) {
        return { get: jest.fn(() => null) };
      }
      return { get: jest.fn(() => null), run: jest.fn(), all: jest.fn(() => []) };
    });

    await request(app)
      .post('/webhooks/twilio')
      .type('form')
      .send({ From: '+15551112222', To: '+19999999999', Body: 'Hi', MessageSid: 'SM_NOCLIENT' });

    await new Promise(r => setTimeout(r, 100));
    expect(sendSMS).not.toHaveBeenCalled();
  });

  test('missing From returns 400', async () => {
    const res = await request(app)
      .post('/webhooks/twilio')
      .type('form')
      .send({ To: '+18005551234', Body: 'Hi' });

    expect(res.status).toBe(400);
  });
});
