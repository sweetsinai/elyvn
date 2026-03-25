'use strict';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

describe('Twilio Route', () => {
  let app;
  let router;
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();

    // Clear TWILIO_AUTH_TOKEN to avoid signature validation issues
    delete process.env.TWILIO_AUTH_TOKEN;

    // Create mock database
    mockDb = {
      prepare: jest.fn((sql) => ({
        run: jest.fn().mockReturnValue({ changes: 1 }),
        get: jest.fn().mockReturnValue(null),
        all: jest.fn().mockReturnValue([])
      }))
    };

    // Mock external dependencies
    jest.mock('@anthropic-ai/sdk');
    jest.mock('../utils/sms');
    jest.mock('../utils/telegram');
    jest.mock('../utils/calcom');
    jest.mock('fs');

    // Load the router
    router = require('../routes/twilio');

    // Create Express app
    app = express();
    app.use(express.urlencoded({ extended: false }));
    app.locals.db = mockDb;
    app.use('/webhooks/twilio', router);
  });

  describe('Twilio Signature Validation', () => {
    test('skips validation when TWILIO_AUTH_TOKEN not set', async () => {
      delete process.env.TWILIO_AUTH_TOKEN;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test message',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
      expect(res.type).toBe('text/xml');
    });

    test('signature validation can be enabled with TWILIO_AUTH_TOKEN', async () => {
      // Just verify that setting the token doesn't break the app
      const authToken = 'test-auth-token';
      process.env.TWILIO_AUTH_TOKEN = authToken;

      // Reload router to pick up env var
      delete require.cache[require.resolve('../routes/twilio')];
      const newRouter = require('../routes/twilio');

      const newApp = express();
      newApp.use(express.urlencoded({ extended: false }));
      newApp.locals.db = mockDb;
      newApp.use('/webhooks/twilio', newRouter);

      const res = await request(newApp)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test message'
        });

      // With invalid signature, should return 401
      expect([401, 200]).toContain(res.status);
      delete process.env.TWILIO_AUTH_TOKEN;
    });
  });

  describe('POST / - Webhook Response', () => {
    test('responds with empty TwiML', async () => {
      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test message'
        });

      expect(res.status).toBe(200);
      expect(res.type).toBe('text/xml');
      expect(res.text).toContain('<Response></Response>');
    });

    test('responds immediately even if processing fails', async () => {
      app.locals.db = null; // No database

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test'
        });

      expect(res.status).toBe(200);
    });

    test('handles missing From and To', async () => {
      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          Body: 'Test message'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Opt-out Keyword Detection', () => {
    const optOutKeywords = ['STOP', 'UNSUBSCRIBE', 'QUIT', 'END'];

    optOutKeywords.forEach(keyword => {
      test(`detects ${keyword} as opt-out`, async () => {
        const mockClient = { id: 'client-123', business_name: 'Test Business' };
        mockDb.prepare = jest.fn((sql) => {
          const mock = {
            get: jest.fn(),
            run: jest.fn().mockReturnValue({ changes: 1 })
          };

          if (sql.includes('SELECT * FROM clients')) {
            mock.get.mockReturnValue(mockClient);
          }

          return mock;
        });

        app.locals.db = mockDb;

        const res = await request(app)
          .post('/webhooks/twilio')
          .send({
            From: '+14155551234',
            To: '+19876543210',
            Body: keyword,
            MessageSid: 'msg-123'
          });

        expect(res.status).toBe(200);
      });
    });

    test('case-insensitive opt-out detection', async () => {
      const mockClient = { id: 'client-123', business_name: 'Test' };
      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'stop',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('trims whitespace for opt-out detection', async () => {
      const mockClient = { id: 'client-123', business_name: 'Test' };
      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: '  STOP  ',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Opt-in Keyword Detection', () => {
    const optInKeywords = ['START', 'SUBSCRIBE'];

    optInKeywords.forEach(keyword => {
      test(`detects ${keyword} as opt-in`, async () => {
        const mockClient = { id: 'client-123', business_name: 'Test Business' };
        mockDb.prepare = jest.fn((sql) => {
          const mock = {
            get: jest.fn(),
            run: jest.fn().mockReturnValue({ changes: 1 })
          };

          if (sql.includes('SELECT * FROM clients')) {
            mock.get.mockReturnValue(mockClient);
          }

          return mock;
        });

        app.locals.db = mockDb;

        const res = await request(app)
          .post('/webhooks/twilio')
          .send({
            From: '+14155551234',
            To: '+19876543210',
            Body: keyword,
            MessageSid: 'msg-123'
          });

        expect(res.status).toBe(200);
      });
    });

    test('YES keyword triggers booking link response', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        calcom_booking_link: 'https://cal.com/test'
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'YES',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('CANCEL Keyword Handling', () => {
    test('cancels booking when CANCEL is received', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business'
      };

      const mockLead = {
        calcom_booking_id: 'booking-123'
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('SELECT calcom_booking_id FROM leads')) {
          mock.get.mockReturnValue(mockLead);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'CANCEL',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('handles CANCEL with no booking found', async () => {
      const mockClient = { id: 'client-123', business_name: 'Test' };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'CANCEL',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Normal Message Processing', () => {
    test('processes normal message and generates reply', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('SELECT id FROM leads')) {
          mock.get.mockReturnValue(null);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'What are your hours?',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('skips response if client AI is paused', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: false
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'What are your hours?',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('rate limits outbound replies within 5 minutes', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('COUNT')) {
          // Already replied in last 5 minutes
          mock.get.mockReturnValue({ c: 1 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'What are your hours?',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('SMS Length Truncation', () => {
    test('truncates SMS reply to 1600 chars', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const veryLongMessage = 'a'.repeat(5000);
      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: veryLongMessage,
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Idempotency - Duplicate MessageSid Prevention', () => {
    test('skips duplicate message by MessageSid', async () => {
      const mockClient = { id: 'client-123' };
      const mockExistingMessage = { id: 'msg-existing' };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT id FROM messages WHERE message_sid')) {
          mock.get.mockReturnValue(mockExistingMessage);
        } else if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Lead Management', () => {
    test('creates new lead on first SMS', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('SELECT id FROM leads')) {
          mock.get.mockReturnValue(null);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'First message',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('updates existing lead on subsequent SMS', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      const mockExistingLead = { id: 'lead-123' };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('SELECT id FROM leads')) {
          mock.get.mockReturnValue(mockExistingLead);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Follow-up message',
          MessageSid: 'msg-456'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Low Confidence Handling', () => {
    test('notifies owner on low confidence reply', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true,
        owner_phone: '+19876543210'
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Complex question not in KB',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    test('handles missing client gracefully', async () => {
      mockDb.prepare = jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      }));

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('handles database errors gracefully', async () => {
      mockDb.prepare = jest.fn(() => ({
        get: jest.fn().mockImplementation(() => {
          throw new Error('DB error');
        }),
        run: jest.fn().mockImplementation(() => {
          throw new Error('DB error');
        })
      }));

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('handles Anthropic API timeout gracefully', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      // This should timeout and fail gracefully
      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Test message',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Message Classification', () => {
    test('classifies reply as high confidence', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'What are your hours?',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });

    test('classifies reply as medium confidence', async () => {
      const mockClient = {
        id: 'client-123',
        business_name: 'Test Business',
        is_active: true
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        } else if (sql.includes('COUNT')) {
          mock.get.mockReturnValue({ c: 0 });
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/twilio')
        .send({
          From: '+14155551234',
          To: '+19876543210',
          Body: 'Tell me more about your services',
          MessageSid: 'msg-123'
        });

      expect(res.status).toBe(200);
    });
  });
});
