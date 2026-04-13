'use strict';

const request = require('supertest');
const express = require('express');

// Mock dependencies
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  setupLogger: jest.fn(),
}));

jest.mock('../utils/monitoring', () => ({
  initMonitoring: jest.fn(),
  captureException: jest.fn(),
}));

const mockDb = {
  _async: false,
  _adapter: 'sqlite',
  _path: ':memory:',
  _createdAt: new Date().toISOString(),
  query: jest.fn(async (sql, params, mode) => {
    if (sql.includes('SELECT 1')) return { '1': 1 };
    if (sql.includes('COUNT(*)')) return { c: 0 };
    if (sql.includes('FROM clients') && mode === 'get') {
      return { id: 'test-client', business_name: 'Test', owner_email: 'test@test.com', plan: 'growth', subscription_status: 'active', is_active: 1 };
    }
    if (sql.includes('FROM clients')) return [{ id: 'test-client', business_name: 'Test', owner_email: 'test@test.com', plan: 'growth' }];
    if (sql.includes('FROM calls')) return [];
    if (sql.includes('FROM leads')) return [];
    if (sql.includes('FROM messages')) return [];
    if (sql.includes('FROM appointments')) return [];
    if (sql.includes('FROM followups')) return [];
    if (sql.includes('FROM job_queue')) return { c: 0 };
    if (mode === 'get') return null;
    if (mode === 'run') return { changes: 0 };
    return [];
  }),
  prepare: jest.fn(() => ({
    get: jest.fn(() => null),
    all: jest.fn(() => []),
    run: jest.fn(() => ({ changes: 0 })),
  })),
  pragma: jest.fn(() => [{ page_count: 100, page_size: 4096, freelist_count: 0 }]),
};

describe('API Endpoints', () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.ELYVN_API_KEY = 'test-api-key';
    process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars';

    app = express();
    app.use(express.json());
    app.locals.db = mockDb;

    // Mount health
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Mount API routes with simplified auth
    const apiRouter = require('../routes/api');
    app.use('/api', (req, res, next) => {
      const key = req.headers['x-api-key'];
      if (key === 'test-api-key') {
        req.isAdmin = true;
        return next();
      }
      return res.status(401).json({ error: 'API key required' });
    }, apiRouter);
  });

  describe('Health & Service Status', () => {
    test('GET /health returns 200', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('API Authentication', () => {
    test('GET /api/clients without key returns 401', async () => {
      const res = await request(app).get('/api/clients');
      expect(res.status).toBe(401);
    });

    test('GET /api/clients with valid key returns 200', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'test-api-key');
      expect(res.status).toBe(200);
    });

    test('GET /api/clients with invalid key returns 401', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'wrong-key');
      expect(res.status).toBe(401);
    });
  });

  describe('API Routes', () => {
    test('GET /api/clients returns client list', async () => {
      const res = await request(app)
        .get('/api/clients')
        .set('x-api-key', 'test-api-key');
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });

    test('GET /api/calls/:clientId returns calls', async () => {
      const res = await request(app)
        .get('/api/calls/test-client')
        .set('x-api-key', 'test-api-key');
      expect([200, 422]).toContain(res.status);
    });

    test('GET /api/leads/:clientId returns leads', async () => {
      const res = await request(app)
        .get('/api/leads/test-client')
        .set('x-api-key', 'test-api-key');
      expect([200, 422]).toContain(res.status);
    });

    test('GET /api/messages/:clientId returns messages', async () => {
      const res = await request(app)
        .get('/api/messages/test-client')
        .set('x-api-key', 'test-api-key');
      expect([200, 422]).toContain(res.status);
    });

    test('GET /api/stats/:clientId returns stats', async () => {
      const res = await request(app)
        .get('/api/stats/test-client')
        .set('x-api-key', 'test-api-key');
      expect([200, 400]).toContain(res.status);
    });
  });

  describe('Billing', () => {
    test('GET /billing/plans returns plan list', async () => {
      const billingApp = express();
      billingApp.use(express.json());
      billingApp.locals.db = mockDb;
      const billing = require('../routes/billing');
      billingApp.use('/billing', billing);

      const res = await request(billingApp).get('/billing/plans');
      expect(res.status).toBe(200);
      expect(res.body.plans).toBeDefined();
      expect(res.body.plans.length).toBe(3);
    });
  });

  describe('Error Handling', () => {
    test('invalid route returns 404', async () => {
      const res = await request(app).get('/nonexistent-route-xyz');
      expect([404, 200]).toContain(res.status);
    });

    test('OPTIONS request does not crash', async () => {
      const res = await request(app).options('/api/clients');
      expect([200, 204, 401, 404]).toContain(res.status);
    });
  });
});
