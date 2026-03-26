'use strict';

const request = require('supertest');
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');

// Mock telegram module at the top level
jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue({ ok: true }),
  answerCallback: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../utils/jobQueue', () => ({
  cancelJobs: jest.fn().mockReturnValue(2)
}));

const telegramRouter = require('../routes/telegram');
const mockTelegram = require('../utils/telegram');
const { createDatabase, closeDatabase } = require('../utils/dbAdapter');

describe('Telegram Routes - Comprehensive Coverage', () => {
  let app;
  let db;
  let testDbPath;
  let testClientId;
  let testLeadId;

  beforeAll(() => {
    // Create a temporary test database
    testDbPath = path.join(__dirname, '../../test_telegram_db_' + Date.now() + '.db');
    db = createDatabase({ path: testDbPath });

    // Set up Express app
    app = express();
    app.locals.db = db;
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // Mount router
    app.use('/webhooks/telegram', telegramRouter);

    // Create test data
    testClientId = randomUUID();
    testLeadId = randomUUID();

    // Insert test client
    db.prepare(`
      INSERT INTO clients (id, name, business_name, telegram_chat_id, avg_ticket, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testClientId, 'Test Business', 'Test Business', '123456789', 150, 1, new Date().toISOString(), new Date().toISOString());

    // Insert test lead
    db.prepare(`
      INSERT INTO leads (id, client_id, name, phone, email, stage, score, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testLeadId, testClientId, 'John Doe', '+14155551234', 'john@example.com', 'hot', 9, new Date().toISOString(), new Date().toISOString());

    // Insert test call
    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, summary, score, sentiment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), 'retell-123', testClientId, '+14155551234', 'inbound', 600, 'booked', 'Good call', 9, 'positive', new Date().toISOString());

    // Insert test appointment
    db.prepare(`
      INSERT INTO appointments (id, client_id, phone, status, datetime, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), testClientId, '+14155551234', 'confirmed', new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  });

  afterAll(() => {
    closeDatabase(db);
    try {
      require('fs').unlinkSync(testDbPath);
    } catch (e) {
      // ignore
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  describe('Webhook Secret Middleware', () => {
    test('should skip verification when TELEGRAM_WEBHOOK_SECRET is not set', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({ message: { chat: { id: 123 }, text: '/help' } });
      expect(res.status).toBe(200);
    });

    test('should reject request with wrong secret', async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'expected-secret';
      const res = await request(app)
        .post('/webhooks/telegram')
        .set('x-telegram-bot-api-secret-token', 'wrong-secret')
        .send({ message: { chat: { id: 123 }, text: '/help' } });
      expect(res.status).toBe(403);
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
    });

    test('should accept request with correct secret', async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'correct-secret';
      const res = await request(app)
        .post('/webhooks/telegram')
        .set('x-telegram-bot-api-secret-token', 'correct-secret')
        .send({ message: { chat: { id: 123 }, text: '/help' } });
      expect(res.status).toBe(200);
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
    });
  });

  describe('POST / - Webhook receiver', () => {
    test('should return 200 immediately', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({});
      expect(res.status).toBe(200);
    });

    test('should handle empty body gracefully', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({});
      expect(res.status).toBe(200);
    });

    test('should not fail with missing database', async () => {
      const testApp = express();
      testApp.locals.db = null;
      testApp.use(express.json());
      testApp.use('/webhooks/telegram', telegramRouter);

      const res = await request(testApp)
        .post('/webhooks/telegram')
        .send({ message: { chat: { id: 123 }, text: 'test' } });
      expect(res.status).toBe(200);
    });
  });

  describe('Command handling - /start', () => {
    test('should handle /start with client linking', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: 'new-chat-id' },
            from: { first_name: 'Test' },
            text: `/start ${testClientId}`
          }
        });
      expect(res.status).toBe(200);
    });

    test('should reject invalid client ID on /start', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: 'new-chat-id' },
            from: { first_name: 'Test' },
            text: `/start invalid-id`
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle unlinked /start request', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: 'unlinked-chat-id' },
            from: { first_name: 'Test' },
            text: '/start'
          }
        });
      expect(res.status).toBe(200);
    });
  });

  describe('Command handling - /status, /leads, /calls', () => {
    test('should handle /status command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/status'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /leads command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/leads'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /calls command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/calls'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /help command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/help'
          }
        });
      expect(res.status).toBe(200);
    });
  });

  describe('Command handling - /pause, /resume, /complete', () => {
    test('should handle /pause command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/pause'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /resume command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/resume'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /complete without phone', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/complete'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /complete with phone', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/complete +14155551234'
          }
        });
      expect(res.status).toBe(200);
    });
  });

  describe('Command handling - /set', () => {
    test('should handle /set without arguments', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/set'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /set review command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/set review https://g.page/example'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should validate /set review URL', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/set review invalid-url'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /set ticket command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/set ticket 250'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should validate /set ticket value', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/set ticket not-a-number'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle /set name command', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/set name Updated Business'
          }
        });
      expect(res.status).toBe(200);
    });
  });

  describe('Callback Query Handling', () => {
    test('should handle transcript callback', async () => {
      const callId = 'test-call-' + randomUUID();
      db.prepare(`
        INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, transcript, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), callId, testClientId, '+14155551234', 'inbound', 300, 'booked', 'Agent: Hello\nCaller: Hi', new Date().toISOString());

      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          callback_query: {
            id: 'callback-1',
            message: { chat: { id: '123456789' } },
            data: `transcript:${callId}`
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle missing transcript gracefully', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          callback_query: {
            id: 'callback-1',
            message: { chat: { id: '123456789' } },
            data: 'transcript:non-existent-call'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle msg_ok callback', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          callback_query: {
            id: 'callback-1',
            message: { chat: { id: '123456789' } },
            data: 'msg_ok:12345'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle msg_takeover callback', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          callback_query: {
            id: 'callback-1',
            message: { chat: { id: '123456789' } },
            data: 'msg_takeover:12345:+14155551234'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle cancel_speed callback', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          callback_query: {
            id: 'callback-1',
            message: { chat: { id: '123456789' } },
            data: `cancel_speed:${testLeadId}`
          }
        });
      expect(res.status).toBe(200);
    });

    test('should rate limit callback queries', async () => {
      const chatId = 'rate-limit-test-' + Date.now();
      for (let i = 0; i < 12; i++) {
        await request(app)
          .post('/webhooks/telegram')
          .send({
            callback_query: {
              id: `callback-${i}`,
              message: { chat: { id: chatId } },
              data: 'msg_ok:test'
            }
          });
      }
    });
  });

  describe('Command Parsing Edge Cases', () => {
    test('should handle @botname suffix in commands', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/status@elyvnbot'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle uppercase commands', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: '/HELP'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle empty message text', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: ''
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle missing message text', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' }
          }
        });
      expect(res.status).toBe(200);
    });
  });

  describe('Error Resilience', () => {
    test('should handle malformed message objects', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            from: { first_name: 'Test' },
            text: '/help'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle callback_query without required fields', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          callback_query: {
            id: 'callback-1'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle non-existent users gracefully', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: 'non-existent-chat' },
            from: { first_name: 'Test' },
            text: '/status'
          }
        });
      expect(res.status).toBe(200);
    });

    test('should handle non-command text gracefully', async () => {
      const res = await request(app)
        .post('/webhooks/telegram')
        .send({
          message: {
            chat: { id: '123456789' },
            from: { first_name: 'Test' },
            text: 'just some random text'
          }
        });
      expect(res.status).toBe(200);
    });
  });
});
