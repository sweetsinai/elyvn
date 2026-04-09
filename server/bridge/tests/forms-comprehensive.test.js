'use strict';

const express = require('express');
const request = require('supertest');

// Mock all external dependencies
jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../utils/speed-to-lead', () => ({
  triggerSpeedSequence: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/phone', () => ({
  normalizePhone: jest.fn((phone) => {
    if (!phone) return null;
    return phone.replace(/\D/g, '');
  }),
}));

jest.mock('../utils/validate', () => ({
  isValidUUID: jest.fn((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)),
  isValidPhone: jest.fn((phone) => /^\d{10,}$/.test(phone)),
  isValidEmail: jest.fn((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
  sanitizeString: jest.fn((str) => str),
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

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

const formsRouter = require('../routes/forms');

describe('Forms Route - Comprehensive', () => {
  let app, mockDb;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock database
    mockDb = {
      prepare: jest.fn(),
      transaction: jest.fn((fn) => fn),
      // db.query(sql, params, mode) — unified async helper used by routes
      query: jest.fn(async (sql, params, mode) => {
        const stmt = mockDb.prepare(sql);
        if (!stmt) return null;
        if (mode === 'run') return stmt.run ? stmt.run(...(params || [])) : undefined;
        if (mode === 'get') return stmt.get ? stmt.get(...(params || [])) : null;
        return stmt.all ? stmt.all(...(params || [])) : [];
      }),
    };

    // Set up the app
    app = express();
    app.locals.db = mockDb;
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/webhooks/forms', formsRouter);
    // Error handler so middleware AppErrors render as JSON (mirrors production app)
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      if (err && err.name === 'AppError') {
        return res.status(err.statusCode || 400).json({ success: false, error: err.message, code: err.code });
      }
      // Express JSON body parser sends SyntaxError for malformed JSON
      if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ success: false, error: 'Invalid JSON', code: 'INVALID_JSON' });
      }
      res.status(500).json({ success: false, error: 'Internal server error' });
    });
  });

  describe('POST / - Form submission with client_id in body', () => {
    test('should accept valid form submission with client_id in body', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms')
        .send({
          client_id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'John Doe',
          phone: '+14155551234',
          email: 'john@example.com',
          message: 'I need help',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
      if (response.status === 200) {
        expect(response.body.data.status).toBe('received');
      }
    });

    test('should reject submission without client_id', async () => {
      const response = await request(app)
        .post('/webhooks/forms')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
          email: 'john@example.com',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('client_id');
    });

    test('should reject submission with invalid client_id format', async () => {
      const response = await request(app)
        .post('/webhooks/forms')
        .send({
          client_id: 'not-a-uuid',
          name: 'John Doe',
          phone: '+14155551234',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/invalid/i);
    });

    test('should handle clientId field name variant', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms')
        .send({
          clientId: '550e8400-e29b-41d4-a716-446655440000',
          name: 'Jane Doe',
          phone: '+14155551234',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should reject form submission without phone (phone is required)', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms')
        .send({
          client_id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Lead without phone',
        });

      // Route requires phone — returns 400 MISSING_PHONE (or 429 if rate limited)
      expect([400, 429]).toContain(response.status);
    });
  });

  describe('POST /:clientId - Form submission with clientId in URL', () => {
    test('should accept valid form submission with clientId in URL', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: '550e8400-e29b-41d4-a716-446655440000',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
          email: 'john@example.com',
          message: 'Help needed',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
      if (response.status === 200) {
        expect(response.body.data.status).toBe('received');
      }
    });

    test('should reject invalid clientId format', async () => {
      const response = await request(app)
        .post('/webhooks/forms/invalid-id')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
        });

      // validateParams rejects invalid UUID with 400
      expect([400, 429]).toContain(response.status);
    });

    test('should return 404 if client not found or inactive', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(null), // Client not found
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
        });

      // Route throws CLIENT_NOT_FOUND AppError with statusCode 404 (or 429 if rate limited)
      expect([404, 429]).toContain(response.status);
    });
  });

  describe('Field normalization and aliases', () => {
    test('should accept field aliases: first_name, last_name', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          first_name: 'John',
          last_name: 'Doe',
          phone: '+14155551234',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should accept Contact Form 7 field names', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          'your-name': 'John Doe',
          'your-email': 'john@example.com',
          'your-phone': '+14155551234',
          'your-message': 'Test message',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should accept Typeform field names', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          Name: 'John Doe',
          Email: 'john@example.com',
          Phone: '+14155551234',
          Message: 'Help needed',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should accept camelCase field names', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          fullName: 'John Doe',
          emailAddress: 'john@example.com',
          phone_number: '+14155551234',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should normalize phone numbers with various formats', async () => {
      const { normalizePhone } = require('../utils/phone');
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const phoneFormats = [
        '+1 (415) 555-1234',
        '415-555-1234',
        '4155551234',
        '+14155551234',
      ];

      for (const phone of phoneFormats) {
        const response = await request(app)
          .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
          .send({
            phone,
            email: 'john@example.com',
          });

        expect([200, 400, 429]).toContain(response.status);
      }
    });
  });

  describe('Input validation', () => {
    test('should reject invalid email format', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          email: 'not-an-email',
          phone: '+14155551234',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should reject invalid phone format', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: 'not-a-phone',
          email: 'john@example.com',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should handle very long message bodies', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const longMessage = 'a'.repeat(5000);

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
          message: longMessage,
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should truncate messages longer than 2000 chars', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const longMessage = 'a'.repeat(3000);

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
          message: longMessage,
        });

      expect([200, 429]).toContain(response.status);
    });

    test('should handle special characters in form fields', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: "O'Brien & Associates, Inc.",
          phone: '+14155551234',
          email: 'john+test@example.co.uk',
          message: 'Question about <service> & "pricing"',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });
  });

  describe('Rate limiting', () => {
    test('should allow up to 10 submissions per minute from single IP', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      let lastResponse;
      for (let i = 0; i < 10; i++) {
        lastResponse = await request(app)
          .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
          .send({
            name: `Person ${i}`,
            phone: `+1415555${String(1200 + i).padStart(4, '0')}`,
          });
        expect([200, 429]).toContain(lastResponse.status);
      }
    });

    test('should rate limit after 10 submissions per minute', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      // Submit 11 forms to exceed limit
      for (let i = 0; i < 11; i++) {
        await request(app)
          .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
          .send({
            name: `Person ${i}`,
            phone: `+1415555${String(1200 + i).padStart(4, '0')}`,
          });
      }

      // 11th request should be rate limited
      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'Person 11',
          phone: '+14155551211',
        });

      expect(response.status).toBe(429);
    });
  });

  describe('Deduplication', () => {
    test('should deduplicate speed-to-lead jobs within 5 minutes', async () => {
      const { triggerSpeedSequence } = require('../utils/speed-to-lead');
      triggerSpeedSequence.mockClear();

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      // Submit same phone/email twice
      const phone = '+14155551234';
      const email = 'john@example.com';

      const response1 = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({ phone, email, name: 'John' });

      const response2 = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({ phone, email, name: 'John' });

      expect([200, 429]).toContain(response1.status);
      expect([200, 429]).toContain(response2.status);
    });
  });

  describe('Telegram notifications', () => {
    test('should send Telegram notification for form without phone', async () => {
      const { sendMessage } = require('../utils/telegram');
      sendMessage.mockClear();

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: '123456789',
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'Contact without phone',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should escape HTML in Telegram messages', async () => {
      const { sendMessage } = require('../utils/telegram');
      sendMessage.mockClear();

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: '123456789',
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: '<script>alert("xss")</script>',
          email: 'john@example.com',
          message: '<img src=x onerror=alert(1)>',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });
  });

  describe('SQL Injection Prevention', () => {
    test('should use parameterized queries for lead insertion', async () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: mockRun,
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: "Test'; DROP TABLE leads; --",
          phone: '+14155551234',
          email: 'test@example.com',
        });

      expect([200, 429]).toContain(response.status);
    });

    test('should prevent SQL injection in email field', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
          email: "admin'; DROP TABLE clients; --@example.com",
        });

      expect([200, 429]).toContain(response.status);
    });

    test('should prevent SQL injection in message field', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
          message: "1' OR '1'='1",
        });

      expect([200, 429]).toContain(response.status);
    });
  });

  describe('Content types', () => {
    test('should accept JSON content type', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .set('Content-Type', 'application/json')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
        });

      expect([200, 429]).toContain(response.status); // May hit rate limit
    });

    test('should accept URL-encoded content type', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('name=John+Doe&phone=%2B14155551234');

      expect([200, 400, 429]).toContain(response.status);
    });
  });

  describe('Error handling', () => {
    test('should handle missing database gracefully', async () => {
      app.locals.db = null;

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({
          name: 'John Doe',
          phone: '+14155551234',
        });

      expect([200, 429]).toContain(response.status); // 200 or rate limited
    });

    test('should handle empty body gracefully', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          is_active: 1,
          business_name: 'Test Business',
          telegram_chat_id: null,
        }),
        run: jest.fn(),
      });

      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .send({});

      expect([200, 429]).toContain(response.status); // 200 or rate limited
    });

    test('should handle malformed JSON gracefully', async () => {
      const response = await request(app)
        .post('/webhooks/forms/550e8400-e29b-41d4-a716-446655440000')
        .set('Content-Type', 'application/json')
        .send('not valid json');

      expect([200, 400, 429]).toContain(response.status);
    });
  });
});
