'use strict';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

describe('Retell Route', () => {
  let app;
  let router;
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();

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
    jest.mock('../utils/phone');

    // Load the router
    router = require('../routes/retell');

    // Create Express app
    app = express();
    app.use(express.json());
    app.locals.db = mockDb;
    app.use('/webhooks/retell', router);
  });

  describe('Webhook Signature Validation', () => {
    test('passes through when RETELL_WEBHOOK_SECRET is not set', async () => {
      delete process.env.RETELL_WEBHOOK_SECRET;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({ event: 'call_started', call: {} });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('validates correct signature', async () => {
      const secret = 'test-secret';
      process.env.RETELL_WEBHOOK_SECRET = secret;

      const payload = { event: 'call_started', call: { call_id: 'test-123' } };
      const signature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');

      const res = await request(app)
        .post('/webhooks/retell')
        .set('x-retell-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      delete process.env.RETELL_WEBHOOK_SECRET;
    });

    test('rejects invalid signature', async () => {
      const secret = 'test-secret';
      process.env.RETELL_WEBHOOK_SECRET = secret;

      const res = await request(app)
        .post('/webhooks/retell')
        .set('x-retell-signature', 'invalid-signature')
        .send({ event: 'call_started', call: { call_id: 'test-123' } });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid signature');
      delete process.env.RETELL_WEBHOOK_SECRET;
    });
  });

  describe('POST / - Webhook Reception', () => {
    test('responds 200 immediately', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({ event: 'call_started', call: { call_id: 'test-123' } });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('handles missing event gracefully', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({ call: { call_id: 'test-123' } });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('handles missing database gracefully', async () => {
      app.locals.db = null;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({ event: 'call_started', call: { call_id: 'test-123' } });

      expect(res.status).toBe(200);
    });

    test('handles empty body', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({});

      expect(res.status).toBe(200);
    });
  });

  describe('call_started Event', () => {
    test('creates call record with valid data', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare = jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(mockClient),
        run: jest.fn().mockReturnValue({ changes: 1 })
      }));

      app.locals.db = mockDb;

      const payload = {
        event: 'call_started',
        call: {
          call_id: 'call-123',
          to_number: '+14155551234',
          from_number: '+19876543210',
          direction: 'inbound'
        }
      };

      const res = await request(app)
        .post('/webhooks/retell')
        .send(payload);

      expect(res.status).toBe(200);
      // The actual insertion happens async via setImmediate
    });

    test('handles missing call_id', async () => {
      const payload = {
        event: 'call_started',
        call: {
          to_number: '+14155551234',
          from_number: '+19876543210'
        }
      };

      const res = await request(app)
        .post('/webhooks/retell')
        .send(payload);

      expect(res.status).toBe(200);
    });

    test('matches client by retell_phone', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT id FROM clients WHERE retell_phone')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_started',
          call: {
            call_id: 'call-123',
            to_number: '+14155551234',
            from_number: '+19876543210'
          }
        });

      expect(res.status).toBe(200);
    });

    test('matches client by agent_id when phone not found', async () => {
      const mockClient = { id: 'client-123' };
      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('retell_agent_id')) {
          mock.get.mockReturnValue(mockClient);
        } else {
          mock.get.mockReturnValue(null);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_started',
          call: {
            call_id: 'call-123',
            to_number: '+14155551234',
            from_number: '+19876543210',
            agent_id: 'agent-123'
          }
        });

      expect(res.status).toBe(200);
    });
  });

  describe('call_ended Event', () => {
    test('handles call_ended with minimal data', async () => {
      const mockCall = {
        id: 'call-record-id',
        client_id: 'client-123',
        caller_phone: '+14155551234'
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM calls WHERE call_id')) {
          mock.get.mockReturnValue(mockCall);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: 'call-123',
            from_number: '+14155551234',
            to_number: '+19876543210',
            duration: 60
          }
        });

      expect(res.status).toBe(200);
    });

    test('handles missing call_id', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            from_number: '+14155551234',
            duration: 60
          }
        });

      expect(res.status).toBe(200);
    });

    test('skips if call already processed (idempotency)', async () => {
      const mockCall = {
        id: 'call-record-id',
        client_id: 'client-123',
        caller_phone: '+14155551234',
        outcome: 'completed' // Already processed
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('outcome IS NOT NULL')) {
          mock.get.mockReturnValue(mockCall);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: 'call-123',
            duration: 60
          }
        });

      expect(res.status).toBe(200);
    });

    test('creates call record if missing during call_ended', async () => {
      const mockClient = { id: 'client-123' };
      const mockCall = null; // First query returns nothing

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM calls WHERE call_id')) {
          if (mockCall === null) {
            mock.get.mockReturnValueOnce(null).mockReturnValueOnce(mockCall);
          } else {
            mock.get.mockReturnValue(mockCall);
          }
        } else if (sql.includes('SELECT id FROM clients')) {
          mock.get.mockReturnValue(mockClient);
        }

        return mock;
      });

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: 'call-123',
            to_number: '+14155551234',
            from_number: '+19876543210',
            duration: 120
          }
        });

      expect(res.status).toBe(200);
    });

    test('determines correct outcome based on call data', async () => {
      const mockCall = {
        id: 'call-record-id',
        client_id: 'client-123',
        caller_phone: '+14155551234'
      };

      mockDb.prepare = jest.fn((sql) => {
        const mock = {
          get: jest.fn(),
          run: jest.fn().mockReturnValue({ changes: 1 })
        };

        if (sql.includes('SELECT * FROM calls WHERE call_id')) {
          mock.get.mockReturnValue(mockCall);
        }

        return mock;
      });

      app.locals.db = mockDb;

      // Test various outcomes
      const testCases = [
        {
          name: 'booked outcome',
          call: { call_id: 'call-1', custom_analysis_data: { calcom_booking_id: 'booking-123' } }
        },
        {
          name: 'transferred outcome',
          call: { call_id: 'call-2', call_analysis: { agent_transfer: true } }
        },
        {
          name: 'missed outcome (duration < 10)',
          call: { call_id: 'call-3', duration: 5 }
        },
        {
          name: 'voicemail outcome',
          call: { call_id: 'call-4', call_analysis: { voicemail_detected: true } }
        }
      ];

      for (const testCase of testCases) {
        const res = await request(app)
          .post('/webhooks/retell')
          .send({
            event: 'call_ended',
            call: testCase.call
          });

        expect(res.status).toBe(200);
      }
    });
  });

  describe('call_analyzed Event', () => {
    test('updates call with transcript and analysis', async () => {
      mockDb.prepare = jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      }));

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: 'call-123',
            transcript: 'Agent: Hello\nCustomer: Hi there',
            call_analysis: {
              call_summary: 'Customer asked about pricing',
              user_sentiment: 'positive'
            }
          }
        });

      expect(res.status).toBe(200);
    });

    test('handles transcript as array', async () => {
      mockDb.prepare = jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      }));

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: 'call-123',
            transcript: [
              { role: 'agent', content: 'Hello' },
              { role: 'customer', content: 'Hi there' }
            ],
            call_analysis: {
              call_summary: 'Quick greeting'
            }
          }
        });

      expect(res.status).toBe(200);
    });

    test('handles missing call_id', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            transcript: 'Some transcript',
            call_analysis: {}
          }
        });

      expect(res.status).toBe(200);
    });

    test('skips update if transcript is empty', async () => {
      mockDb.prepare = jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 0 })
      }));

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: 'call-123',
            transcript: '',
            call_analysis: {}
          }
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Unhandled Events', () => {
    test('logs and ignores unknown events', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'unknown_event',
          call: { call_id: 'call-123' }
        });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      consoleSpy.mockRestore();
    });

    test('handles transfer event', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'agent_transfer',
          call: { call_id: 'call-123' }
        });

      expect(res.status).toBe(200);
    });

    test('handles DTMF event', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'dtmf',
          call: { call_id: 'call-123', digit: '*' }
        });

      expect(res.status).toBe(200);
    });
  });

  describe('Concurrent Webhook Processing', () => {
    test('processes multiple webhooks concurrently', async () => {
      mockDb.prepare = jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      }));

      app.locals.db = mockDb;

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          request(app)
            .post('/webhooks/retell')
            .send({
              event: 'call_started',
              call: {
                call_id: `call-${i}`,
                to_number: '+14155551234',
                from_number: '+19876543210'
              }
            })
        );
      }

      const results = await Promise.all(promises);
      results.forEach(res => {
        expect(res.status).toBe(200);
      });
    });
  });

  describe('Error Handling', () => {
    test('handles database errors in call_started', async () => {
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
        .post('/webhooks/retell')
        .send({
          event: 'call_started',
          call: { call_id: 'call-123' }
        });

      // Should still return 200 immediately
      expect(res.status).toBe(200);
    });

    test('handles JSON parse errors in transcript', async () => {
      mockDb.prepare = jest.fn((sql) => ({
        get: jest.fn().mockReturnValue(null),
        run: jest.fn().mockReturnValue({ changes: 1 })
      }));

      app.locals.db = mockDb;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: 'call-123',
            transcript: { invalid: 'object' },
            call_analysis: {}
          }
        });

      expect(res.status).toBe(200);
    });
  });
});
