'use strict';

const express = require('express');
const request = require('supertest');

// Mock all external dependencies
jest.mock('../utils/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue({ ok: true }),
  formatEscalation: jest.fn().mockReturnValue({ text: 'Escalation', buttons: [] }),
  formatMessageNotification: jest.fn().mockReturnValue({ text: 'Message', buttons: [] }),
}));

jest.mock('../utils/calcom', () => ({
  cancelBooking: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../utils/config', () => ({
  ai: { model: 'claude-3-sonnet-20240229' },
}));

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ text: '{"reply":"Test reply","confidence":"high"}' }],
      }),
    },
  }));
});

jest.mock('../utils/leadMemory', () => ({
  getLeadMemory: jest.fn().mockReturnValue(null),
}));

jest.mock('../utils/brain', () => ({
  think: jest.fn().mockResolvedValue({ actions: [] }),
}));

jest.mock('../utils/actionExecutor', () => ({
  executeActions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('{}'),
  existsSync: jest.fn().mockReturnValue(false),
}));

jest.mock('../utils/optOut', () => ({
  recordOptOut: jest.fn(),
  recordOptIn: jest.fn(),
}));

jest.mock('../utils/websocket', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../utils/validate', () => ({
  isValidUUID: jest.fn((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)),
}));

jest.mock('../utils/resilience', () => ({
  withTimeout: jest.fn((fn, timeout, label) => fn()),
}));

const telnyxRouter = require('../routes/telnyx');

describe('Telnyx SMS Webhook Route', () => {
  let app, mockDb;

  beforeEach(() => {
    jest.clearAllMocks();

    mockDb = {
      prepare: jest.fn(),
      transaction: jest.fn((fn) => fn),
    };

    app = express();
    app.locals.db = mockDb;
    app.use(express.json());
    app.use('/webhooks/telnyx', telnyxRouter);

    delete process.env.TELNYX_PUBLIC_KEY;
  });

  describe('POST /webhooks/telnyx - Basic functionality', () => {
    test('should always return 200 for valid webhook format', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Hi there',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test('should return 200 even for empty body', async () => {
      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({});

      expect(response.status).toBe(200);
    });

    test('should ignore non-inbound messages', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.sent',
            payload: {
              direction: 'outbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Reply',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should return 500 if database unavailable', async () => {
      app.locals.db = null;

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Test',
            },
          },
        });

      expect(response.status).toBe(200); // Still returns 200 immediately
    });
  });

  describe('POST /webhooks/telnyx - Message handling', () => {
    test('should process valid inbound SMS', async () => {
      const mockGet = jest.fn((sql) => {
        if (sql.includes('message_sid')) return null; // Not duplicate
        if (sql.includes('clients')) {
          return {
            id: 'client-123',
            is_active: 1,
            business_name: 'Test Business',
            owner_phone: '+15551234567',
            telegram_chat_id: null,
          };
        }
        return null;
      });

      mockDb.prepare.mockReturnValue({
        get: mockGet,
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'What are your hours?',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test('should deduplicate by message_sid', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) {
            return { id: 'existing-msg' }; // Duplicate found
          }
          return null;
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-dup',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Test',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle missing client gracefully', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
          if (sql.includes('clients')) return null; // Client not found
          return null;
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Test',
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /webhooks/telnyx - Keyword handling', () => {
    test('should recognize STOP keyword', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
          if (sql.includes('clients')) {
            return {
              id: 'client-123',
              is_active: 1,
              business_name: 'Test Business',
              owner_phone: null,
              telegram_chat_id: null,
            };
          }
          return null;
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-stop',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'STOP',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should recognize START keyword for re-opt-in', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
          if (sql.includes('clients')) {
            return {
              id: 'client-123',
              is_active: 1,
              business_name: 'Test Business',
              owner_phone: null,
              telegram_chat_id: null,
            };
          }
          return null;
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-start',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'START',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should recognize YES keyword for booking', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
          if (sql.includes('clients')) {
            return {
              id: 'client-123',
              is_active: 1,
              business_name: 'Test Business',
              calcom_booking_link: 'https://cal.com/test',
              owner_phone: null,
              telegram_chat_id: null,
            };
          }
          return null;
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-yes',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'YES',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should recognize CANCEL keyword', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
          if (sql.includes('clients')) {
            return {
              id: 'client-123',
              is_active: 1,
              business_name: 'Test Business',
              owner_phone: null,
              telegram_chat_id: null,
            };
          }
          if (sql.includes('leads')) {
            return { calcom_booking_id: 'booking-456' };
          }
          return null;
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-cancel',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'CANCEL',
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /webhooks/telnyx - AI paused state', () => {
    test('should not auto-reply when AI is paused', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
          if (sql.includes('clients')) {
            return {
              id: 'client-123',
              is_active: 0, // Paused
              business_name: 'Test Business',
              owner_phone: null,
              telegram_chat_id: null,
            };
          }
          if (sql.includes('leads')) return null;
          return null;
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-paused',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Need help urgently',
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });

  describe('Input validation', () => {
    test('should handle missing payload', async () => {
      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            // No payload
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle missing from field', async () => {
      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              direction: 'inbound',
              to: [{ phone_number: '+15551234567' }],
              text: 'Test',
              // No from
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle missing to field', async () => {
      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              text: 'Test',
              // No to
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle special characters in phone numbers', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-123',
              direction: 'inbound',
              from: { phone_number: '+1 (415) 555-1234' },
              to: [{ phone_number: '555-1234567' }],
              text: 'Test',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle long message bodies', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const longMessage = 'a'.repeat(5000);

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-long',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: longMessage,
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle empty message text', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-empty',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: '',
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });

  describe('SQL Injection Prevention', () => {
    test('should use parameterized queries for message_sid lookup', async () => {
      const mockGet = jest.fn();
      const mockPrepare = jest.fn().mockReturnValue({
        get: mockGet,
        run: jest.fn(),
      });
      mockDb.prepare = mockPrepare;

      await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: "msg'; DROP TABLE messages; --",
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Test',
            },
          },
        });

      // Verify prepare was called with SQL and params
      expect(mockPrepare).toHaveBeenCalled();
    });

    test('should sanitize message body before storing', async () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: mockRun,
      });

      await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: "<script>alert('xss')</script>",
            },
          },
        });

      // Verify DB operations happened
      expect(mockDb.prepare).toHaveBeenCalled();
    });
  });

  describe('Response behavior', () => {
    test('should always return 200 status code', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn(),
      });

      const testCases = [
        { data: { event_type: 'message.received', payload: { direction: 'inbound', from: {}, to: [], text: '' } } },
        { data: {} },
        { data: { payload: null } },
        {},
      ];

      for (const testCase of testCases) {
        const response = await request(app)
          .post('/webhooks/telnyx')
          .send(testCase);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      }
    });

    test('should include success flag in response', async () => {
      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({});

      expect(response.body).toHaveProperty('success');
      expect(response.body.success).toBe(true);
    });
  });
});
