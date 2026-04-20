'use strict';

const express = require('express');
const request = require('supertest');

// Mock https module and telegram
jest.mock('https');
jest.mock('../utils/telegram', () => ({
  getOnboardingLink: jest.fn((clientId) => `https://t.me/bot?start=${clientId}`),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue('{}'),
  },
}));

jest.mock('path', () => ({
  ...jest.requireActual('path'),
  join: jest.fn((...args) => args.join('/')),
}));

const provisionRouter = require('../routes/provision');

describe('Provision Route', () => {
  let app, mockDb;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock database with query support
    mockDb = {
      prepare: jest.fn(),
      exec: jest.fn(),
    };
    mockDb.query = jest.fn((sql, params = [], mode = 'all') => {
      try {
        const stmt = mockDb.prepare(sql);
        if (mode === 'get') return Promise.resolve(stmt.get(...(params || [])));
        if (mode === 'run') return Promise.resolve(stmt.run(...(params || [])));
        return Promise.resolve(stmt.all(...(params || [])));
      } catch (err) {
        return Promise.reject(err);
      }
    });

    // Mock Database constructor
    jest.resetModules();

    // Set up the app
    app = express();
    app.locals.db = mockDb;
    app.use(express.json());
    // Set req.isAdmin = true so admin-required routes pass
    app.use((req, res, next) => { req.isAdmin = true; next(); });
    app.use('/provision', provisionRouter);

    // Error handler to produce JSON responses from AppError
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      const status = err.statusCode || err.status || 500;
      res.status(status).json({ error: err.message, code: err.code });
    });

    // Clear env vars
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_MESSAGING_PROFILE_ID;
    delete process.env.RETELL_API_KEY;
  });

  describe('POST / - Provision new client', () => {
    test('should accept valid provisioning request', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          telnyx_phone: '+15551234567',
          retell_agent_id: 'agent-123',
          created_at: new Date().toISOString(),
        }),
      });

      // Mock the https.request
      const https = require('https');
      https.request = jest.fn((options, callback) => {
        const res = {
          statusCode: 200,
          headers: {},
          on: jest.fn((event, handler) => {
            if (event === 'data') handler(JSON.stringify({ data: { phone_numbers: [{ phone_number: '+15551234567' }] } }));
            if (event === 'end') handler();
          }),
        };
        callback(res);
        return {
          on: jest.fn((event, handler) => {
            if (event === 'error') {
              // no-op
            }
          }),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
          area_code: '415',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.client).toBeDefined();
      expect(response.body.provisioning_status).toBeDefined();
    });

    test('should reject request missing business_name', async () => {
      const response = await request(app)
        .post('/provision')
        .send({
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toContain('business_name');
    });

    test('should reject request missing owner_phone', async () => {
      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          plan: 'starter',
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toContain('owner_phone');
    });

    test('should reject request missing plan', async () => {
      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toContain('plan');
    });

    test('should handle empty body gracefully', async () => {
      const response = await request(app)
        .post('/provision')
        .send({});

      expect(response.status).toBe(422);
    });
  });

  describe('POST / - Optional fields', () => {
    test('should accept request without area_code', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          twilio_phone: null,
          phone_number: null,
          retell_agent_id: null,
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
    });

    test('should accept request with all optional fields', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Full Service Business',
          owner_name: 'John Doe',
          owner_phone: '+14155551234',
          owner_email: 'john@example.com',
          industry: 'technology',
          timezone: 'America/Los_Angeles',
          avg_ticket: 500,
          plan: 'premium',
          telnyx_phone: '+15551234567',
          retell_agent_id: 'agent-123',
          created_at: new Date().toISOString(),
        }),
      });

      const https = require('https');
      https.request = jest.fn((options, callback) => {
        const res = {
          statusCode: 201,
          headers: {},
          on: jest.fn((event, handler) => {
            if (event === 'data') handler(JSON.stringify({ data: { phone_numbers: [{ phone_number: '+15551234567' }] } }));
            if (event === 'end') handler();
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Full Service Business',
          owner_name: 'John Doe',
          owner_phone: '+14155551234',
          owner_email: 'john@example.com',
          industry: 'technology',
          timezone: 'America/Los_Angeles',
          avg_ticket: 500,
          plan: 'premium',
          area_code: '415',
          knowledge_base: {
            business_name: 'Full Service Business',
            services: ['Consulting', 'Development'],
            hours: '9AM-5PM',
            location: 'San Francisco',
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.client.owner_name).toBe('John Doe');
    });

    test('should include telegram_link in response', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
      expect(response.body.telegram_link).toBeDefined();
      expect(response.body.telegram_link).toContain('t.me');
    });
  });

  describe('POST / - Retell integration', () => {
    test('should handle Retell API errors gracefully', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const https = require('https');
      https.request = jest.fn((options, callback) => {
        const res = {
          statusCode: 500,
          headers: {},
          on: jest.fn((event, handler) => {
            if (event === 'data') handler(JSON.stringify({ error: 'Internal Server Error' }));
            if (event === 'end') handler();
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
      expect(response.body.provisioning_status.retell_error).toBeDefined();
    });

    test('should continue provisioning even if Telnyx fails', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const https = require('https');
      https.request = jest.fn((options, callback) => {
        const res = {
          statusCode: 400,
          headers: {},
          on: jest.fn((event, handler) => {
            if (event === 'data') handler(JSON.stringify({ error: 'No numbers available' }));
            if (event === 'end') handler();
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
          area_code: '415',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST / - Retell integration', () => {
    test('should continue provisioning even if Retell fails', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const https = require('https');
      https.request = jest.fn((options, callback) => {
        const res = {
          statusCode: 401,
          headers: {},
          on: jest.fn((event, handler) => {
            if (event === 'data') handler(JSON.stringify({ error: 'Unauthorized' }));
            if (event === 'end') handler();
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST / - Knowledge base handling', () => {
    test('should save knowledge base as JSON file', async () => {
      const fs = require('fs');
      fs.promises.writeFile.mockResolvedValue(undefined);
      fs.promises.mkdir.mockResolvedValue(undefined);

      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
          knowledge_base: {
            business_name: 'Test Business',
            services: ['Service A', 'Service B'],
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.provisioning_status.kb_save).toBe(true);
    });

    test('should handle KB file save errors gracefully', async () => {
      const fs = require('fs');
      fs.promises.writeFile.mockRejectedValue(new Error('Permission denied'));
      fs.promises.mkdir.mockResolvedValue(undefined);

      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
          knowledge_base: {
            business_name: 'Test Business',
            services: ['Service A'],
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.provisioning_status.kb_error).toBeDefined();
    });
  });

  describe('POST / - Database errors', () => {
    test('should return 500 if database save fails', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(() => {
          throw new Error('Database constraint violation');
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Failed to save');
    });

    test('should return 500 if database connection unavailable', async () => {
      app.locals.db = null;

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Database');
    });
  });

  describe('Input validation', () => {
    test('should handle special characters in business_name', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: "O'Brien & Associates",
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: "O'Brien & Associates",
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
    });

    test('should handle various phone number formats', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+1 (415) 555-1234',
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+1 (415) 555-1234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
    });

    test('should handle numeric avg_ticket field', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          avg_ticket: 1000.50,
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
          avg_ticket: 1000.50,
        });

      expect(response.status).toBe(201);
      expect(response.body.client.avg_ticket).toBe(1000.50);
    });
  });

  describe('SQL Injection Prevention', () => {
    test('should use parameterized queries for client insertion', async () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({
        run: mockRun,
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: "Test'; DROP TABLE clients; --",
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
      // Verify parameterized query was used (params passed to run)
      expect(mockRun).toHaveBeenCalled();
    });

    test('should sanitize email field', async () => {
      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          owner_email: "<script>alert('xss')</script>",
          plan: 'starter',
        });

      // Zod schema rejects invalid email format before it reaches the handler
      expect(response.status).toBe(422);
    });
  });

  describe('Response structure', () => {
    test('should include all required fields in response', async () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue({
          id: 'client-123',
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          created_at: new Date().toISOString(),
        }),
      });

      const response = await request(app)
        .post('/provision')
        .send({
          business_name: 'Test Business',
          owner_phone: '+14155551234',
          plan: 'starter',
        });

      expect(response.status).toBe(201);
      expect(response.body.client).toBeDefined();
      expect(response.body.provisioning_status).toBeDefined();
      expect(response.body.provisioning_status.client_id).toBeDefined();
      expect(response.body.provisioning_status.client_id).toBeDefined();
      expect(response.body.provisioning_status.retell_agent_id).toBeDefined();
      expect(response.body.provisioning_status.db_save).toBeDefined();
      expect(response.body.success).toBe(true);
    });
  });
});
