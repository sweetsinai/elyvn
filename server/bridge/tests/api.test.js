'use strict';

const request = require('supertest');
const express = require('express');
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

jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

jest.mock('../utils/resilience', () => ({
  withTimeout: jest.fn((promise) => promise)
}));

jest.mock('../utils/inputValidation', () => ({
  validateEmail: jest.fn(() => ({ valid: true })),
  validatePhone: jest.fn(() => ({ valid: true })),
  validateLength: jest.fn(() => ({ valid: true })),
  sanitizeString: jest.fn((s) => s),
  LENGTH_LIMITS: { name: 200, text: 500, url: 2000 },
  validateParameters: jest.fn(() => ({ valid: true }))
}));

const apiRouter = require('../routes/api');

describe('API Routes - Comprehensive Coverage', () => {
  let app;
  let db;
  let testClientId;
  let testLeadId;
  let testCallId;
  let testMessageId;

  // In-memory data store
  let clients;
  let leads;
  let calls;
  let messages;
  let appointments;
  let weeklyReports;

  beforeAll(() => {
    testClientId = randomUUID();
    testLeadId = randomUUID();
    testCallId = randomUUID();
    testMessageId = randomUUID();

    const now = new Date().toISOString();

    clients = [
      {
        id: testClientId, name: 'Test Business', business_name: 'Test Business',
        avg_ticket: 150, created_at: now, updated_at: now,
        owner_name: null, owner_phone: null, owner_email: null,
        calcom_event_type_id: null
      }
    ];

    leads = [
      {
        id: testLeadId, client_id: testClientId, name: 'John Doe',
        phone: '+14155551234', email: 'john@example.com', stage: 'contacted',
        score: 8, updated_at: now, created_at: now
      }
    ];

    calls = [
      {
        id: testCallId, call_id: 'retell-' + testCallId, client_id: testClientId,
        caller_phone: '+14155551234', direction: 'inbound', duration: 600,
        outcome: 'booked', summary: 'Good call, interested in service',
        score: 9, sentiment: 'positive', created_at: now
      }
    ];

    messages = [
      {
        id: testMessageId, client_id: testClientId, phone: '+14155551234',
        direction: 'inbound', body: 'Hello, interested in your service', created_at: now
      }
    ];

    appointments = [
      {
        id: randomUUID(), client_id: testClientId, phone: '+14155551234',
        status: 'confirmed', datetime: now, created_at: now, updated_at: now
      }
    ];

    weeklyReports = [];

    // Build a mock db that handles the SQL queries the routes use
    db = createMockDb();

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
  });

  function createMockDb() {
    // Returns a mock db object that handles prepare().get/all/run
    return {
      prepare: jest.fn((sql) => {
        const normalizedSql = sql.replace(/\s+/g, ' ').trim();
        return {
          get: jest.fn((...params) => handleGet(normalizedSql, params)),
          all: jest.fn((...params) => handleAll(normalizedSql, params)),
          run: jest.fn((...params) => handleRun(normalizedSql, params))
        };
      })
    };
  }

  function handleGet(sql, params) {
    // COUNT queries
    if (sql.includes('COUNT(*)')) {
      if (sql.includes('FROM calls')) {
        const clientId = params[0];
        const filtered = calls.filter(c => c.client_id === clientId);
        return { count: filtered.length };
      }
      if (sql.includes('FROM messages')) {
        const clientId = params[0];
        const filtered = messages.filter(m => m.client_id === clientId);
        return { count: filtered.length };
      }
      if (sql.includes('FROM leads')) {
        const clientId = params[0];
        let filtered = leads.filter(l => l.client_id === clientId);
        if (sql.includes('stage = ?')) {
          const stage = params[1];
          filtered = filtered.filter(l => l.stage === stage);
        }
        return { count: filtered.length };
      }
    }

    // SELECT avg_ticket FROM clients
    if (sql.includes('avg_ticket') && sql.includes('FROM clients') && !sql.includes('*')) {
      const clientId = params[0];
      const client = clients.find(c => c.id === clientId);
      return client ? { avg_ticket: client.avg_ticket } : undefined;
    }

    // SELECT calcom_event_type_id FROM clients
    if (sql.includes('calcom_event_type_id') && sql.includes('FROM clients') && !sql.includes('*')) {
      const clientId = params[0];
      const client = clients.find(c => c.id === clientId);
      return client ? { calcom_event_type_id: client.calcom_event_type_id } : undefined;
    }

    // SELECT * FROM clients WHERE id = ?
    if (sql.includes('FROM clients WHERE id')) {
      const clientId = params[0];
      return clients.find(c => c.id === clientId) || undefined;
    }

    return undefined;
  }

  function handleAll(sql, params) {
    // SELECT * FROM clients ORDER BY ...
    if (sql.includes('FROM clients') && sql.includes('ORDER BY')) {
      return [...clients];
    }

    // SELECT stage, COUNT(*) ... FROM leads ... GROUP BY stage
    if (sql.includes('FROM leads') && sql.includes('GROUP BY stage')) {
      const clientId = params[0];
      const clientLeads = leads.filter(l => l.client_id === clientId);
      const stageCounts = {};
      clientLeads.forEach(l => {
        stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1;
      });
      return Object.entries(stageCounts).map(([stage, count]) => ({ stage, count }));
    }

    // SELECT ... FROM calls WHERE ... ORDER BY ... LIMIT ? OFFSET ?
    if (sql.includes('FROM calls') && sql.includes('ORDER BY') && !sql.includes('GROUP BY')) {
      const clientId = params[0];
      let filtered = calls.filter(c => c.client_id === clientId);
      // Check for outcome filter
      if (sql.includes('outcome = ?')) {
        const outcome = params[1];
        filtered = filtered.filter(c => c.outcome === outcome);
      }
      // Check for score filter
      if (sql.includes('score >= ?')) {
        const scoreIdx = sql.includes('outcome = ?') ? 2 : 1;
        const minScore = params[scoreIdx];
        filtered = filtered.filter(c => c.score >= minScore);
      }
      // Check for caller_phone IN (...)
      if (sql.includes('caller_phone IN')) {
        const phoneParams = params.slice(1); // skip clientId
        filtered = calls.filter(c => c.client_id === clientId && phoneParams.includes(c.caller_phone));
      }
      return filtered;
    }

    // SELECT ... FROM messages WHERE ... ORDER BY ... LIMIT ? OFFSET ?
    if (sql.includes('FROM messages') && sql.includes('ORDER BY')) {
      const clientId = params[0];
      let filtered = messages.filter(m => m.client_id === clientId);
      // Check for phone IN (...)
      if (sql.includes('phone IN')) {
        const phoneParams = params.slice(1);
        filtered = messages.filter(m => m.client_id === clientId && phoneParams.includes(m.phone));
      }
      return filtered;
    }

    // SELECT ... FROM leads WHERE ... ORDER BY ... LIMIT ? OFFSET ?
    if (sql.includes('FROM leads') && sql.includes('ORDER BY')) {
      const clientId = params[0];
      let filtered = leads.filter(l => l.client_id === clientId);
      if (sql.includes('stage = ?')) {
        const stage = params[1];
        filtered = filtered.filter(l => l.stage === stage);
      }
      return filtered;
    }

    // SELECT * FROM weekly_reports
    if (sql.includes('FROM weekly_reports')) {
      const clientId = params[0];
      return weeklyReports.filter(r => r.client_id === clientId);
    }

    return [];
  }

  function handleRun(sql, params) {
    // UPDATE leads SET stage = ?
    if (sql.includes('UPDATE leads SET stage')) {
      const stage = params[0];
      // updated_at = params[1], leadId = params[2], clientId = params[3]
      const leadId = params[2];
      const clientId = params[3];
      const lead = leads.find(l => l.id === leadId && l.client_id === clientId);
      if (lead) {
        lead.stage = stage;
        lead.updated_at = params[1];
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    // INSERT INTO clients
    if (sql.includes('INSERT INTO clients')) {
      const newClient = {
        id: params[0], business_name: params[1], owner_name: params[2],
        owner_phone: params[3], owner_email: params[4],
        retell_agent_id: params[5], retell_phone: params[6],
        twilio_phone: params[7], transfer_phone: params[8],
        industry: params[9], timezone: params[10],
        calcom_event_type_id: params[11], calcom_booking_link: params[12],
        avg_ticket: params[13], created_at: params[14], updated_at: params[15]
      };
      clients.push(newClient);
      return { changes: 1 };
    }

    // UPDATE clients SET ...
    if (sql.includes('UPDATE clients SET')) {
      const clientId = params[params.length - 1];
      const client = clients.find(c => c.id === clientId);
      if (client) {
        // Parse SET clauses from the sql to map params to fields
        const setMatch = sql.match(/SET (.+) WHERE/);
        if (setMatch) {
          const setClauses = setMatch[1].split(',').map(s => s.trim().split(' = ')[0].trim());
          setClauses.forEach((field, i) => {
            if (field !== 'updated_at') {
              client[field] = params[i];
            }
          });
          client.updated_at = new Date().toISOString();
        }
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    return { changes: 0 };
  }

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

    test('should create a client with valid business_name', async () => {
      const res = await request(app)
        .post('/api/clients')
        .set('x-api-key', 'test-api-key-12345')
        .send({
          business_name: 'New Test Business',
          owner_name: 'Jane Doe'
        });
      expect(res.status).toBe(201);
      expect(res.body.client).toBeDefined();
      expect(res.body.client.business_name).toBe('New Test Business');
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
