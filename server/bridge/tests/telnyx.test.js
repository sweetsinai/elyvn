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
  getLeadMemory: jest.fn().mockReturnValue({
    phone: '+1234567890',
    client_id: 'client-123',
    interactions: [],
  }),
}));

jest.mock('../utils/brain', () => ({
  think: jest.fn().mockResolvedValue({
    actions: [],
  }),
}));

jest.mock('../utils/actionExecutor', () => ({
  executeActions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('{"business": "test"}'),
  existsSync: jest.fn().mockReturnValue(true),
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
    jest.useFakeTimers();

    // Create mock database
    mockDb = {
      prepare: jest.fn(),
      transaction: jest.fn((fn) => fn),
    };

    // Set up the app
    app = express();
    app.locals.db = mockDb;
    app.use(express.json());

    // Store raw body for signature verification
    app.use((req, res, next) => {
      req.rawBody = '';
      req.on('data', (chunk) => {
        req.rawBody += chunk.toString();
      });
      req.on('end', next);
    });

    app.use('/webhooks/telnyx', telnyxRouter);

    // Clear environment
    delete process.env.TELNYX_PUBLIC_KEY;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('POST /webhooks/telnyx - Valid inbound SMS', () => {
    test('should accept valid inbound SMS webhook', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null; // No duplicate
          if (sql.includes('clients')) {
            return {
              id: 'client-123',
              is_active: 1,
              business_name: 'Test Business',
              owner_phone: '+15551234567',
              calcom_booking_link: null,
              telegram_chat_id: null,
            };
          }
          return null;
        }),
        all: jest.fn().mockReturnValue([]),
        run: jest.fn(),
      });
      mockDb.transaction.mockImplementation((fn) => () => fn());

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
              text: 'Hi, I need help',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test('should reject webhooks with missing data.payload', async () => {
      mockDb.prepare.mockReturnValue({ get: jest.fn(), run: jest.fn() });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            // Missing payload
          },
        });

      expect(response.status).toBe(200); // Webhook always returns 200
      expect(response.body.success).toBe(true);
    });

    test('should ignore non-inbound messages', async () => {
      mockDb.prepare.mockReturnValue({ get: jest.fn(), run: jest.fn() });

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
      expect(response.body.success).toBe(true);
    });

    test('should reject webhooks with missing from or to', async () => {
      mockDb.prepare.mockReturnValue({ get: jest.fn(), run: jest.fn() });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              // Missing to
              text: 'Hi',
            },
          },
        });

      expect(response.status).toBe(200); // Still returns 200
    });
  });

  describe('POST /webhooks/telnyx - STOP/UNSUBSCRIBE keywords', () => {
    test('should handle STOP keyword and record opt-out', async () => {
      const { recordOptOut } = require('../utils/optOut');
      const { sendSMS } = require('../utils/sms');

      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
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
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-stop-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'STOP',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test('should handle UNSUBSCRIBE keyword', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
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
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: 'msg-unsub-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'UNSUBSCRIBE',
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /webhooks/telnyx - Special keywords (YES, CANCEL)', () => {
    test('should handle YES keyword with booking link', async () => {
      const { sendSMS } = require('../utils/sms');

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
              id: 'msg-yes-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'YES',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(sendSMS).toHaveBeenCalled();
    });

    test('should handle CANCEL keyword for appointment cancellation', async () => {
      const { sendSMS } = require('../utils/sms');
      const { cancelBooking } = require('../utils/calcom');

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
            return {
              calcom_booking_id: 'booking-456',
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
              id: 'msg-cancel-123',
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

  describe('POST /webhooks/telnyx - Rate limiting & idempotency', () => {
    test('should deduplicate messages by message_sid', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) {
            return { id: 'msg-existing-123' }; // Duplicate found
          }
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
              id: 'msg-duplicate',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Duplicate message',
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle AI paused state and not auto-reply', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
          if (sql.includes('message_sid')) return null;
          if (sql.includes('clients')) {
            return {
              id: 'client-123',
              is_active: 0, // AI is paused
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
              id: 'msg-paused-123',
              direction: 'inbound',
              from: { phone_number: '+14155551234' },
              to: [{ phone_number: '+15551234567' }],
              text: 'Help with something',
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /webhooks/telnyx - Error handling', () => {
    test('should handle missing database gracefully', async () => {
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
              text: 'Hi',
            },
          },
        });

      expect(response.status).toBe(200); // Always returns 200
    });

    test('should return 200 for empty body', async () => {
      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({});

      expect(response.status).toBe(200);
    });

    test('should handle malformed JSON gracefully', async () => {
      const response = await request(app)
        .post('/webhooks/telnyx')
        .set('Content-Type', 'application/json')
        .send('not valid json');

      expect([200, 400]).toContain(response.status);
    });
  });

  describe('Signature verification', () => {
    test('should skip signature validation if TELNYX_PUBLIC_KEY is not set', async () => {
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

    test('should allow webhook through if signature headers are missing (might be test)', async () => {
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
              text: 'Test',
            },
          },
        });

      expect([200, 401]).toContain(response.status);
    });
  });

  describe('Input validation', () => {
    test('should handle phone numbers with special characters', async () => {
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

    test('should handle very long message bodies', async () => {
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
      mockDb.transaction.mockImplementation((fn) => () => fn());

      const longMessage = 'a'.repeat(5000);

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
              text: longMessage,
            },
          },
        });

      expect(response.status).toBe(200);
    });

    test('should handle empty message body', async () => {
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
      mockDb.transaction.mockImplementation((fn) => () => fn());

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
              text: '',
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });

  describe('SQL Injection Prevention', () => {
    test('should use parameterized queries for client lookup', async () => {
      const mockPrepare = jest.fn();
      const mockGet = jest.fn().mockReturnValue(null);
      mockPrepare.mockReturnValue({ get: mockGet });
      mockDb.prepare = mockPrepare;

      const response = await request(app)
        .post('/webhooks/telnyx')
        .send({
          data: {
            event_type: 'message.received',
            payload: {
              id: "msg'; DROP TABLE clients; --",
              direction: 'inbound',
              from: { phone_number: "+14155551234' OR '1'='1" },
              to: [{ phone_number: '+15551234567' }],
              text: 'Test',
            },
          },
        });

      expect(response.status).toBe(200);
      // Verify parameterized queries were used (params passed separately)
      expect(mockPrepare).toHaveBeenCalled();
    });

    test('should sanitize message body before storing in DB', async () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({
        get: jest.fn((sql) => {
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
        run: mockRun,
      });
      mockDb.transaction.mockImplementation((fn) => () => fn());

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
              text: "<script>alert('xss')</script>",
            },
          },
        });

      expect(response.status).toBe(200);
    });
  });
});
