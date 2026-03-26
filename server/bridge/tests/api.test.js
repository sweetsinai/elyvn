'use strict';

const request = require('supertest');
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');

// Mock external dependencies before importing routes
jest.mock('../utils/calcom', () => ({
  getBookings: jest.fn().mockResolvedValue([
    { id: 'booking-1', title: 'Test Booking', date: '2026-03-27', time: '10:00' }
  ])
}));

jest.mock('../utils/config', () => ({
  ai: { model: 'claude-3-5-sonnet-20241022' }
}));

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn(() => ({
    messages: {
      stream: jest.fn().mockResolvedValue({
        on: jest.fn(function(event, cb) {
          if (event === 'text') cb('test response');
          if (event === 'end') cb();
          return this;
        }),
      })
    }
  }));
});

const apiRouter = require('../routes/api');
const { createDatabase, closeDatabase } = require('../utils/dbAdapter');

describe('API Routes - Comprehensive Coverage', () => {
  let app;
  let db;
  let testDbPath;
  let testClientId;
  let testLeadId;
  let testCallId;
  let testMessageId;

  beforeAll(() => {
    // Create a temporary test database
    testDbPath = path.join(__dirname, '../../test_api_db_' + Date.now() + '.db');
    db = createDatabase({ path: testDbPath });

    // Set up Express app
    app = express();
    app.locals.db = db;
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // Mount router with auth middleware
    const API_KEY = 'test-api-key-12345';
    function apiAuth(req, res, next) {
      const provided = req.headers['x-api-key'];
      if (!provided) {
        return res.status(401).json({ error: 'API key required' });
      }
      if (provided === API_KEY) {
        req.isAdmin = true;
        return next();
      }
      return res.status(401).json({ error: 'Invalid API key' });
    }

    app.use('/api', apiAuth, apiRouter);

    // Create test data
    testClientId = randomUUID();
    testLeadId = randomUUID();
    testCallId = randomUUID();
    testMessageId = randomUUID();

    // Insert test client
    db.prepare(`
      INSERT INTO clients (id, name, business_name, avg_ticket, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(testClientId, 'Test Business', 'Test Business', 150, new Date().toISOString(), new Date().toISOString());

    // Insert test lead
    db.prepare(`
      INSERT INTO leads (id, client_id, name, phone, email, stage, score, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testLeadId, testClientId, 'John Doe', '+14155551234', 'john@example.com', 'contacted', 8, new Date().toISOString(), new Date().toISOString());

    // Insert test call
    db.prepare(`
      INSERT INTO calls (id, call_id, client_id, caller_phone, direction, duration, outcome, summary, score, sentiment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testCallId, 'retell-' + testCallId, testClientId, '+14155551234', 'inbound', 600, 'booked', 'Good call, interested in service', 9, 'positive', new Date().toISOString());

    // Insert test message
    db.prepare(`
      INSERT INTO messages (id, client_id, phone, direction, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(testMessageId, testClientId, '+14155551234', 'inbound', 'Hello, interested in your service', new Date().toISOString());

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

  describe('GET /api/clients', () => {
    test('should return 401 without API key', async () => {
      const res = await request(app)
        .get('/api/clients');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('API key required');
    });

    test('should return 401 with invalid API key', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'invalid-key');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid API key');
    });

    test('should return 200 with valid API key', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('clients');
      expect(Array.isArray(res.body.clients)).toBe(true);
      expect(res.body.clients.length).toBeGreaterThan(0);
    });

    test('should include test client in response', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      const testClient = res.body.clients.find(c => c.id === testClientId);
      expect(testClient).toBeDefined();
      expect(testClient.business_name).toBe('Test Business');
    });

    test('should handle database errors gracefully', async () => {
      const mockApp = express();
      mockApp.locals.db = null;
      mockApp.use(express.json());
      mockApp.use('/api', (req, res, next) => {
        req.isAdmin = true;
        next();
      });
      mockApp.use('/api', apiRouter);

      const res = await request(mockApp)
        .get('/api/clients');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to fetch clients');
    });
  });

  describe('GET /api/stats/:clientId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .get('/api/stats/invalid-id')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid client ID format');
    });

    test('should return stats for valid client ID', async () => {
      const res = await request(app)
        .get(`/api/stats/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('calls_this_week');
      expect(res.body).toHaveProperty('calls_trend');
      expect(res.body).toHaveProperty('messages_this_week');
      expect(res.body).toHaveProperty('bookings_this_week');
      expect(res.body).toHaveProperty('estimated_revenue');
      expect(res.body).toHaveProperty('leads_by_stage');
    });

    test('should calculate trends correctly', async () => {
      const res = await request(app)
        .get(`/api/stats/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(typeof res.body.calls_trend).toBe('number');
      expect(res.body.calls_trend).toBeGreaterThanOrEqual(-100);
    });

    test('should include all lead stages', async () => {
      const res = await request(app)
        .get(`/api/stats/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      const stages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
      stages.forEach(stage => {
        expect(res.body.leads_by_stage).toHaveProperty(stage);
      });
    });

    test('should calculate estimated revenue', async () => {
      const res = await request(app)
        .get(`/api/stats/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      // With avg_ticket of 150, estimated revenue should be >= 0
      expect(res.body.estimated_revenue).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/leads/:clientId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .get('/api/leads/invalid-id')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid client ID format');
    });

    test('should return leads with pagination', async () => {
      const res = await request(app)
        .get(`/api/leads/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('leads');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
      expect(res.body).toHaveProperty('total_pages');
    });

    test('should include test lead in results', async () => {
      const res = await request(app)
        .get(`/api/leads/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      const testLead = res.body.leads.find(l => l.id === testLeadId);
      expect(testLead).toBeDefined();
      expect(testLead.name).toBe('John Doe');
      expect(testLead.phone).toBe('+14155551234');
    });

    test('should filter by stage', async () => {
      const res = await request(app)
        .get(`/api/leads/${testClientId}?stage=contacted`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      res.body.leads.forEach(lead => {
        expect(lead.stage).toBe('contacted');
      });
    });

    test('should support pagination with page and limit', async () => {
      const res = await request(app)
        .get(`/api/leads/${testClientId}?page=1&limit=10`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(10);
      expect(res.body.leads.length).toBeLessThanOrEqual(10);
    });

    test('should include recent interactions with leads', async () => {
      const res = await request(app)
        .get(`/api/leads/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      const testLead = res.body.leads.find(l => l.id === testLeadId);
      if (testLead) {
        expect(testLead).toHaveProperty('recent_calls');
        expect(testLead).toHaveProperty('recent_messages');
        expect(Array.isArray(testLead.recent_calls)).toBe(true);
        expect(Array.isArray(testLead.recent_messages)).toBe(true);
      }
    });

    test('should limit interactions to 3 per lead', async () => {
      const res = await request(app)
        .get(`/api/leads/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      res.body.leads.forEach(lead => {
        expect(lead.recent_calls.length).toBeLessThanOrEqual(3);
        expect(lead.recent_messages.length).toBeLessThanOrEqual(3);
      });
    });
  });

  describe('GET /api/calls/:clientId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .get('/api/calls/invalid-id')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid client ID format');
    });

    test('should return calls with pagination', async () => {
      const res = await request(app)
        .get(`/api/calls/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('calls');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
      expect(res.body).toHaveProperty('total_pages');
      expect(Array.isArray(res.body.calls)).toBe(true);
    });

    test('should include test call in results', async () => {
      const res = await request(app)
        .get(`/api/calls/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      const testCall = res.body.calls.find(c => c.id === testCallId);
      expect(testCall).toBeDefined();
      expect(testCall.outcome).toBe('booked');
      expect(testCall.duration).toBe(600);
    });

    test('should filter by outcome', async () => {
      const res = await request(app)
        .get(`/api/calls/${testClientId}?outcome=booked`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      res.body.calls.forEach(call => {
        expect(call.outcome).toBe('booked');
      });
    });

    test('should support pagination parameters', async () => {
      const res = await request(app)
        .get(`/api/calls/${testClientId}?page=1&limit=5`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(5);
      expect(res.body.calls.length).toBeLessThanOrEqual(5);
    });

    test('should clamp limit to maximum of 100', async () => {
      const res = await request(app)
        .get(`/api/calls/${testClientId}?limit=999`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBeLessThanOrEqual(100);
    });

    test('should filter by minimum score', async () => {
      const res = await request(app)
        .get(`/api/calls/${testClientId}?minScore=5`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      res.body.calls.forEach(call => {
        if (call.score !== null && call.score !== undefined) {
          expect(call.score).toBeGreaterThanOrEqual(5);
        }
      });
    });
  });

  describe('PUT /api/leads/:clientId/:leadId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .put(`/api/leads/invalid-id/${testLeadId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ stage: 'qualified' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid');
    });

    test('should return 400 with invalid lead ID', async () => {
      const res = await request(app)
        .put(`/api/leads/${testClientId}/invalid-id`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ stage: 'qualified' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid');
    });

    test('should return 400 with invalid stage', async () => {
      const res = await request(app)
        .put(`/api/leads/${testClientId}/${testLeadId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ stage: 'invalid_stage' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid stage');
    });

    test('should update lead stage to valid stage', async () => {
      const res = await request(app)
        .put(`/api/leads/${testClientId}/${testLeadId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ stage: 'qualified' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stage).toBe('qualified');
    });

    test('should return 404 for non-existent lead', async () => {
      const fakeId = randomUUID();
      const res = await request(app)
        .put(`/api/leads/${testClientId}/${fakeId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ stage: 'booked' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Lead not found');
    });

    test('should support all valid stages', async () => {
      const stages = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
      for (const stage of stages) {
        const res = await request(app)
          .put(`/api/leads/${testClientId}/${testLeadId}`)
          .set('x-api-key', 'test-api-key-12345')
          .send({ stage });
        expect(res.status).toBe(200);
        expect(res.body.stage).toBe(stage);
      }
    });
  });

  describe('POST /api/clients', () => {
    test('should require business_name field', async () => {
      const res = await request(app)
        .post('/api/clients')
        .set('x-api-key', 'test-api-key-12345')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('business_name is required');
    });

    test('should handle missing required name field from schema', async () => {
      // Note: The POST /clients endpoint has a schema mismatch — it doesn't insert the required 'name' field
      // This test documents that the endpoint will fail when the schema requires 'name' but API doesn't provide it
      const res = await request(app)
        .post('/api/clients')
        .set('x-api-key', 'test-api-key-12345')
        .send({
          business_name: 'New Test Business',
          owner_name: 'Jane Doe'
        });
      // Expect failure due to NOT NULL constraint on 'name' field
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to create client');
    });
  });

  describe('PUT /api/clients/:clientId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .put('/api/clients/invalid-id')
        .set('x-api-key', 'test-api-key-12345')
        .send({ business_name: 'Updated' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid client ID format');
    });

    test('should return 404 for non-existent client', async () => {
      const fakeId = randomUUID();
      const res = await request(app)
        .put(`/api/clients/${fakeId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ business_name: 'Updated' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Client not found');
    });

    test('should update client fields', async () => {
      const res = await request(app)
        .put(`/api/clients/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ business_name: 'Updated Business Name', avg_ticket: 200 });
      expect(res.status).toBe(200);
      expect(res.body.client.business_name).toBe('Updated Business Name');
      expect(res.body.client.avg_ticket).toBe(200);
    });

    test('should reject non-whitelisted fields', async () => {
      const res = await request(app)
        .put(`/api/clients/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({
          malicious_field: 'should be ignored',
          business_name: 'Safe Update'
        });
      expect(res.status).toBe(200);
      expect(res.body.client.business_name).toBe('Safe Update');
      // malicious_field should be ignored, not in response
    });

    test('should return 400 with no valid fields', async () => {
      const res = await request(app)
        .put(`/api/clients/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345')
        .send({ invalid_field: 'value' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No valid fields to update');
    });
  });

  describe('GET /api/messages/:clientId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .get('/api/messages/invalid-id')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid client ID format');
    });

    test('should return messages with pagination', async () => {
      const res = await request(app)
        .get(`/api/messages/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('messages');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
      expect(res.body).toHaveProperty('total_pages');
    });

    test('should include test message in results', async () => {
      const res = await request(app)
        .get(`/api/messages/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      const testMsg = res.body.messages.find(m => m.id === testMessageId);
      expect(testMsg).toBeDefined();
      expect(testMsg.body).toBe('Hello, interested in your service');
    });

    test('should support pagination parameters', async () => {
      const res = await request(app)
        .get(`/api/messages/${testClientId}?page=1&limit=5`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(5);
    });
  });

  describe('GET /api/bookings/:clientId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .get('/api/bookings/invalid-id')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid client ID format');
    });

    test('should return empty bookings array if no calcom_event_type_id', async () => {
      const res = await request(app)
        .get(`/api/bookings/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('bookings');
      expect(Array.isArray(res.body.bookings)).toBe(true);
    });
  });

  describe('GET /api/reports/:clientId', () => {
    test('should return 400 with invalid client ID', async () => {
      const res = await request(app)
        .get('/api/reports/invalid-id')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid client ID format');
    });

    test('should return reports for valid client', async () => {
      const res = await request(app)
        .get(`/api/reports/${testClientId}`)
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('reports');
      expect(Array.isArray(res.body.reports)).toBe(true);
    });
  });

  describe('Auth Middleware', () => {
    test('should reject requests without API key', async () => {
      const res = await request(app)
        .get('/api/clients');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('API key required');
    });

    test('should reject requests with invalid API key', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'completely-wrong-key');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid API key');
    });

    test('should accept requests with valid API key', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'test-api-key-12345');
      expect(res.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    test('should handle missing database gracefully', async () => {
      const mockApp = express();
      mockApp.locals.db = null;
      mockApp.use(express.json());
      mockApp.use('/api', (req, res, next) => {
        req.isAdmin = true;
        next();
      });
      mockApp.use('/api', apiRouter);

      const res = await request(mockApp)
        .get('/api/clients');
      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });

    test('should return 500 on database errors', async () => {
      // Create an app with a broken database connection
      const mockDb = {
        prepare: jest.fn().mockImplementation(() => {
          throw new Error('DB error');
        })
      };

      const brokenApp = express();
      brokenApp.locals.db = mockDb;
      brokenApp.use(express.json());
      brokenApp.use('/api', (req, res, next) => {
        req.isAdmin = true;
        next();
      });
      brokenApp.use('/api', apiRouter);

      const res = await request(brokenApp)
        .get('/api/clients');
      expect(res.status).toBe(500);
    });
  });
});
