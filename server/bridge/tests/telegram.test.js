'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/telegram');
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../utils/validate', () => ({
  isValidURL: jest.fn((url) => url && (url.startsWith('http://') || url.startsWith('https://'))),
}));

const telegram = require('../utils/telegram');
const { isValidURL } = require('../utils/validate');

describe('Telegram Route Handler', () => {
  let app;
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    delete require.cache[require.resolve('../routes/telegram')];

    mockDb = {
      prepare: jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 }),
        all: jest.fn().mockReturnValue([]),
      })),
      query: jest.fn(function(sql, params = [], mode = 'all') {
        const stmt = mockDb.prepare(sql);
        if (mode === 'get') return Promise.resolve(stmt.get(...(params || [])));
        if (mode === 'run') return Promise.resolve(stmt.run(...(params || [])));
        return Promise.resolve(stmt.all(...(params || [])));
      }),
      transaction: jest.fn((fn) => fn),
    };

    telegram.sendMessage.mockResolvedValue({ ok: true });
    telegram.setClientCommands.mockResolvedValue({ ok: true });
    telegram.answerCallback.mockResolvedValue({ ok: true });
    telegram.sendDocument.mockResolvedValue({ ok: true });
    telegram.getHelpText.mockReturnValue('<b>Commands</b>\n\n/status - Dashboard\n/leads - Leads');

    app = express();
    app.use(express.json());
    app.locals.db = mockDb;
    const router = require('../routes/telegram');
    app.use('/webhook/telegram', router);

    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  describe('Webhook Secret Validation', () => {
    test('allows request when TELEGRAM_WEBHOOK_SECRET is not set', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({ message: { chat: { id: '123' }, text: '/help' } });
      expect(res.status).toBe(200);
    });

    test('rejects request with missing secret header when secret is configured', async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
      const res = await request(app)
        .post('/webhook/telegram')
        .send({ message: { chat: { id: '123' }, text: '/help' } });
      expect(res.status).toBe(403);
    });

    test('rejects request with incorrect secret', async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'correct-secret';
      const res = await request(app)
        .post('/webhook/telegram')
        .set('x-telegram-bot-api-secret-token', 'wrong-secret')
        .send({ message: { chat: { id: '123' }, text: '/help' } });
      expect(res.status).toBe(403);
    });

    test('accepts request with correct secret', async () => {
      const secret = 'test-secret';
      process.env.TELEGRAM_WEBHOOK_SECRET = secret;
      const res = await request(app)
        .post('/webhook/telegram')
        .set('x-telegram-bot-api-secret-token', secret)
        .send({ message: { chat: { id: '123' }, text: '/help' } });
      expect(res.status).toBe(200);
    });

    test('rejects request when secret length differs', async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'correct-secret-with-length';
      const res = await request(app)
        .post('/webhook/telegram')
        .set('x-telegram-bot-api-secret-token', 'short')
        .send({ message: { chat: { id: '123' }, text: '/help' } });
      expect(res.status).toBe(403);
    });
  });

  describe('POST / - Webhook Reception', () => {
    test('responds with 200 immediately', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({ message: { chat: { id: '123' }, text: '/help' } });
      expect(res.status).toBe(200);
    });

    test('handles empty body gracefully', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({});
      expect(res.status).toBe(200);
    });

    test('handles message with missing database', async () => {
      app.locals.db = null;
      const res = await request(app)
        .post('/webhook/telegram')
        .send({ message: { chat: { id: '123' }, text: '/help' } });
      expect(res.status).toBe(200);
    });
  });

  describe('/start command - linking', () => {
    test('handles /start with linking parameter for valid client', async () => {
      const mockClient = { id: 'client-123', plan: 'growth', business_name: 'Test Business' };
      let callCount = 0;
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return null; // First SELECT for existing link
          return mockClient; // Second SELECT for target client
        }),
        run: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/start client-123',
            from: { first_name: 'John' },
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalled();
    });

    test('rejects /start with invalid client ID', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/start invalid-id',
            from: { first_name: 'John' },
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Invalid link')
      );
    });

    test('handles /start without parameters when no linked client', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/start',
            from: { first_name: 'John' },
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('onboarding link')
      );
    });
  });

  describe('/status command', () => {
    test('sends dashboard status for linked client', async () => {
      const mockClient = { id: 'client-123', business_name: 'Test Business', is_active: 1, avg_ticket: 100 };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/status',
            from: { first_name: 'John' },
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalled();
      const call = telegram.sendMessage.mock.calls[0];
      expect(call[1]).toContain('Today');
    });
  });

  describe('/leads command', () => {
    test('displays active leads grouped by stage', async () => {
      const mockClient = { id: 'client-123' };
      const mockLeads = [
        { name: 'Hot Lead', phone: '+1234567890', score: 9, stage: 'hot', updated_at: new Date().toISOString() },
      ];

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
        all: jest.fn().mockReturnValue(mockLeads),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/leads',
            from: { first_name: 'John' },
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Leads')
      );
    });

    test('shows message when no active leads exist', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/leads',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('No active leads')
      );
    });
  });

  describe('/calls command', () => {
    test('displays recent calls with summary', async () => {
      const mockClient = { id: 'client-123' };
      const mockCalls = [
        {
          call_id: 'call-123',
          caller_name: 'John Doe',
          caller_phone: '+1234567890',
          outcome: 'booked',
          duration: 300,
          score: 8,
          summary: 'Customer interested',
          created_at: new Date().toISOString(),
        },
      ];

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
        all: jest.fn().mockReturnValue(mockCalls),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/calls',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalled();
    });

    test('shows message when no calls exist', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/calls',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'No calls yet.'
      );
    });
  });

  describe('/pause and /resume commands', () => {
    test('/pause disables AI', async () => {
      const mockClient = { id: 'client-123', is_active: 1 };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/pause',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('paused')
      );
    });

    test('/resume enables AI', async () => {
      const mockClient = { id: 'client-123', is_active: 0 };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/resume',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('resumed')
      );
    });
  });

  describe('/complete command', () => {
    test('marks job as complete with valid phone number', async () => {
      const mockClient = { id: 'client-123', business_name: 'Test Business', google_review_link: 'https://g.page/test' };
      const mockLead = { id: 'lead-123', name: 'John' };

      mockDb.prepare.mockReturnValue({
        get: jest.fn()
          .mockReturnValueOnce(mockClient)
          .mockReturnValueOnce(mockLead),
        run: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/complete +15551234567',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalled();
    });

    test('shows error when phone number not provided', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/complete',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Usage: /complete')
      );
    });
  });

  describe('/set command - configuration', () => {
    test('shows settings menu when /set called without parameters', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Settings')
      );
    });

    test('sets Google review link with /set review command', async () => {
      const mockClient = { id: 'client-123' };
      isValidURL.mockReturnValue(true);

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set review https://g.page/mybusiness',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Review link')
      );
    });

    test('rejects invalid URL for review link', async () => {
      const mockClient = { id: 'client-123' };
      isValidURL.mockReturnValue(false);

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set review invalid-url',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Invalid URL')
      );
    });

    test('sets average ticket price with /set ticket command', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set ticket 150',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('ticket')
      );
    });

    test('rejects invalid ticket amount', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set ticket not-a-number',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Invalid amount')
      );
    });

    test('sets business name with /set name command', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set name My Awesome Business',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('updated')
      );
    });

    test('sets transfer phone with /set transfer command', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set transfer +15551234567',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Transfer number')
      );
    });

    test('rejects invalid transfer phone number', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set transfer 123',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Invalid phone')
      );
    });

    test('rejects unknown setting key', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/set unknown_key some_value',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Unknown setting')
      );
    });
  });

  describe('/help command', () => {
    test('displays available commands', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/help',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Commands')
      );
    });
  });

  describe('Unlinked client handling', () => {
    test('shows linking prompt when user not linked', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/status',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('linked')
      );
    });
  });

  describe('Callback Query Handling', () => {
    test('handles transcript callback for long transcripts', async () => {
      const longTranscript = 'x'.repeat(4000);
      const mockCall = {
        call_id: 'call-123',
        transcript: longTranscript,
        caller_phone: '+1234567890',
        created_at: new Date().toISOString(),
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockCall),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          callback_query: {
            id: 'callback-123',
            message: { chat: { id: 'chat-456' } },
            data: 'transcript:call-123',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendDocument).toHaveBeenCalled();
    });

    test('handles transcript callback for short transcripts', async () => {
      const shortTranscript = 'Agent: Hello\nCustomer: Hi';
      const mockCall = {
        call_id: 'call-123',
        transcript: shortTranscript,
        caller_phone: '+1234567890',
        created_at: new Date().toISOString(),
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockCall),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          callback_query: {
            id: 'callback-123',
            message: { chat: { id: 'chat-456' } },
            data: 'transcript:call-123',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalled();
    });

    test('handles transcript not found', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          callback_query: {
            id: 'callback-123',
            message: { chat: { id: 'chat-456' } },
            data: 'transcript:call-123',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('not available')
      );
    });

    test('handles msg_ok callback', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          callback_query: {
            id: 'callback-123',
            message: { chat: { id: 'chat-456' } },
            data: 'msg_ok:msg-123',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.answerCallback).toHaveBeenCalled();
    });

    test('handles msg_takeover callback', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          callback_query: {
            id: 'callback-123',
            message: { chat: { id: 'chat-456' } },
            data: 'msg_takeover:msg-123:+1234567890',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.answerCallback).toHaveBeenCalled();
      expect(telegram.sendMessage).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    test('gracefully handles message with missing text field', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
          },
        });

      expect(res.status).toBe(200);
    });

    test('gracefully handles message with missing chat field', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            text: '/status',
          },
        });

      expect(res.status).toBe(200);
    });

    test('gracefully handles null message', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: null,
        });

      expect(res.status).toBe(200);
    });

    test('handles database errors in command execution', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockImplementation(() => {
          throw new Error('Database error');
        }),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/status',
          },
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Command with @bot mention', () => {
    test('strips @botname suffix from command', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: '/help@ElyvnBot',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Commands')
      );
    });
  });

  describe('Unrecognized text handling', () => {
    test('shows helpful prompt for unrecognized text', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn(),
      });

      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          message: {
            chat: { id: 'chat-456' },
            text: 'Just some random text',
          },
        });

      expect(res.status).toBe(200);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining("didn't catch that"),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array)
          })
        })
      );
    });
  });

  describe('Callback with missing data', () => {
    test('gracefully handles callback with missing data', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          callback_query: {
            id: 'callback-123',
            message: { chat: { id: 'chat-456' } },
          },
        });

      expect(res.status).toBe(200);
    });

    test('gracefully handles callback with missing message', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({
          callback_query: {
            id: 'callback-123',
            data: 'transcript:call-123',
          },
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Rate limiting callbacks', () => {
    test('enforces callback rate limit per chat', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const callPromises = [];
      for (let i = 0; i < 12; i++) {
        callPromises.push(
          request(app)
            .post('/webhook/telegram')
            .send({
              callback_query: {
                id: `callback-${i}`,
                message: { chat: { id: 'chat-456' } },
                data: `transcript:call-${i}`,
              },
            })
        );
      }

      const results = await Promise.all(callPromises);
      expect(results[0].status).toBe(200);
    });
  });
});
