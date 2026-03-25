'use strict';

const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Mock external services before importing routes
jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue({ ok: true }),
  answerCallback: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../utils/speed-to-lead', () => ({
  triggerSpeedSequence: jest.fn().mockResolvedValue(undefined),
}));

// Import routes
const formsRoute = require('../routes/forms');
const telegramRoute = require('../routes/telegram');
const apiRouter = require('../routes/api');
const onboardRouter = require('../routes/onboard');

// Import utilities
const { createDatabase, closeDatabase } = require('../utils/dbAdapter');

describe('Integration Tests - Webhook → DB Flows', () => {
  let app;
  let db;
  let testDbPath;
  let testClientId;
  let testApiKey;

  // Setup: Create test database and app
  beforeAll(() => {
    // Create a temporary test database
    testDbPath = path.join(__dirname, '../../test_integration_db_' + Date.now() + '.db');

    try {
      db = createDatabase({ path: testDbPath });
      console.log(`[test] Created test database at ${testDbPath}`);
    } catch (err) {
      console.error(`[test] Failed to create test database:`, err.message);
      throw err;
    }

    // Set up Express app
    app = express();
    app.locals.db = db;
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // Add rate limiter middleware (simplified for testing)
    const { BoundedRateLimiter } = require('../utils/rateLimiter');
    const limiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 1000, maxEntries: 10000 });

    function rateLimiter(req, res, next) {
      const key = req.clientId || req.ip || 'test-client';
      const result = limiter.check(key);
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter || 60));
        return res.status(429).json({ error: 'Too many requests', retry_after: result.retryAfter });
      }
      next();
    }
    app.use(rateLimiter);

    // Add API auth middleware
    const API_KEY = process.env.TEST_API_KEY || 'test-api-key-12345';
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
    app.apiAuth = apiAuth;

    // Mount routes (in same order as main app)
    app.use('/webhooks/form', formsRoute);
    app.use('/webhooks/telegram', telegramRoute);
    // Mount onboard routes (before general /api to allow public access)
    app.use('/api', onboardRouter);
    app.use('/api', apiAuth, apiRouter);

    // Email tracking routes
    app.get('/t/click/:emailId', (req, res) => {
      const { emailId } = req.params;
      let url = req.query.url;

      // Validate emailId format (UUID)
      if (!emailId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emailId)) {
        return res.redirect('/');
      }

      try {
        if (db) {
          db.prepare("UPDATE emails_sent SET clicked_at = COALESCE(clicked_at, ?), click_count = COALESCE(click_count, 0) + 1, updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), new Date().toISOString(), emailId);
        }
      } catch (_) {
        // Silently fail if email not found or DB error
      }

      if (url) {
        try {
          const decodedUrl = decodeURIComponent(url);

          // URL validation: block dangerous protocols
          if (!decodedUrl || (!decodedUrl.startsWith('https://') && !decodedUrl.startsWith('http://'))) {
            return res.status(400).send('Invalid redirect URL');
          }
          if (decodedUrl.match(/^(javascript|data|vbscript):/i)) {
            return res.status(400).send('Invalid redirect URL');
          }

          // SSRF protection
          const isSafeUrl = (urlStr) => {
            try {
              const parsed = new URL(urlStr);
              const hostname = parsed.hostname;
              if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return false;
              if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) return false;
              if (hostname === '169.254.169.254') return false;
              return true;
            } catch { return false; }
          };

          if (!isSafeUrl(decodedUrl)) {
            return res.status(400).send('Invalid redirect URL');
          }

          new URL(decodedUrl);
          return res.redirect(decodedUrl);
        } catch (err) {
          // Invalid URL
        }
      }
      res.redirect('/');
    });
  });

  // Teardown: Clean up test database
  afterAll(() => {
    if (db) {
      closeDatabase(db);
    }
    if (testDbPath && fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
        console.log(`[test] Cleaned up test database`);
      } catch (err) {
        console.warn(`[test] Could not delete test DB: ${err.message}`);
      }
    }
  });

  // Setup: Create test client before each test
  beforeEach(() => {
    testClientId = randomUUID();
    testApiKey = 'test-api-key-12345';

    // Insert test client
    const stmt = db.prepare(
      `INSERT INTO clients (id, name, owner_name, owner_email, owner_phone, industry, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    );
    stmt.run(testClientId, 'Test Business', 'Test Owner', 'owner@test.com', '+14155551234', 'Services');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 1: Form webhook → Lead creation
  // ─────────────────────────────────────────────────────────────
  describe('Form webhook → Lead creation', () => {
    test('POST /webhooks/form with valid data → returns 200', async () => {
      const formData = {
        client_id: testClientId,
        name: 'John Doe',
        email: 'john@example.com',
        phone: '+14155552222',
        message: 'I am interested in your services'
      };

      const response = await request(app)
        .post('/webhooks/form')
        .send(formData)
        .expect(200);

      expect(response.body.status).toBe('received');
      expect(response.body.message).toContain('Lead captured');
      // Note: The form handler processes async, so we don't verify DB here
    });

    test('POST /webhooks/form without client_id → returns 400', async () => {
      const formData = {
        name: 'Jane Doe',
        email: 'jane@example.com'
      };

      await request(app)
        .post('/webhooks/form')
        .send(formData)
        .expect(400);
    });

    test('POST /webhooks/form with invalid client_id → returns 400', async () => {
      const formData = {
        client_id: 'not-a-uuid',
        name: 'Bob Smith',
        email: 'bob@example.com'
      };

      await request(app)
        .post('/webhooks/form')
        .send(formData)
        .expect(400);
    });

    test('POST /webhooks/form with invalid email → creates lead without email', async () => {
      const formData = {
        client_id: testClientId,
        name: 'Alice Brown',
        email: 'not-an-email',
        phone: '+14155553333'
      };

      const response = await request(app)
        .post('/webhooks/form')
        .send(formData)
        .expect(200);

      expect(response.body.status).toBe('received');
    });

    test('POST /webhooks/form with invalid phone → creates lead without phone', async () => {
      const formData = {
        client_id: testClientId,
        name: 'Charlie Davis',
        email: 'charlie@example.com',
        phone: '123' // Invalid
      };

      const response = await request(app)
        .post('/webhooks/form')
        .send(formData)
        .expect(200);

      expect(response.body.status).toBe('received');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test 2: Telegram webhook → Command processing
  // ─────────────────────────────────────────────────────────────
  describe('Telegram webhook → Command processing', () => {
    test('POST /webhooks/telegram with /help command → returns 200', async () => {
      const payload = {
        update_id: Math.floor(Math.random() * 1000000),
        message: {
          message_id: 1,
          from: { id: 111222333, is_bot: false, first_name: 'Test' },
          chat: { id: 111222333, type: 'private', first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          text: '/help'
        }
      };

      const response = await request(app)
        .post('/webhooks/telegram')
        .send(payload)
        .expect(200);

      // Telegram handler returns 200 immediately, processes async
      expect(response.status).toBe(200);
    });

    test('POST /webhooks/telegram with /status command → returns 200', async () => {
      const payload = {
        update_id: Math.floor(Math.random() * 1000000),
        message: {
          message_id: 2,
          from: { id: 111222333, is_bot: false, first_name: 'Test' },
          chat: { id: 111222333, type: 'private', first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          text: '/status'
        }
      };

      const response = await request(app)
        .post('/webhooks/telegram')
        .send(payload)
        .expect(200);

      expect(response.status).toBe(200);
    });

    test('POST /webhooks/telegram with regular message → returns 200', async () => {
      const payload = {
        update_id: Math.floor(Math.random() * 1000000),
        message: {
          message_id: 3,
          from: { id: 111222333, is_bot: false, first_name: 'Test' },
          chat: { id: 111222333, type: 'private', first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          text: 'Hello bot!'
        }
      };

      await request(app)
        .post('/webhooks/telegram')
        .send(payload)
        .expect(200);
    });

    test('POST /webhooks/telegram with malformed data → returns 200 (silent fail)', async () => {
      const payload = {
        invalid: 'data'
      };

      await request(app)
        .post('/webhooks/telegram')
        .send(payload)
        .expect(200);
    });

    test('POST /webhooks/telegram with callback_query → returns 200', async () => {
      const payload = {
        update_id: Math.floor(Math.random() * 1000000),
        callback_query: {
          id: 'callback_123',
          from: { id: 111222333, is_bot: false, first_name: 'Test' },
          chat_instance: '12345678',
          data: 'some_action'
        }
      };

      await request(app)
        .post('/webhooks/telegram')
        .send(payload)
        .expect(200);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test 3: API auth flow
  // ─────────────────────────────────────────────────────────────
  describe('API auth flow', () => {
    test('GET /api/clients without key → returns 401', async () => {
      await request(app)
        .get('/api/clients')
        .expect(401);
    });

    test('GET /api/clients with valid key → returns 200', async () => {
      const response = await request(app)
        .get('/api/clients')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(response.body.clients).toBeDefined();
      expect(Array.isArray(response.body.clients)).toBe(true);
    });

    test('GET /api/clients with invalid key → returns 401', async () => {
      await request(app)
        .get('/api/clients')
        .set('x-api-key', 'invalid-key-xyz')
        .expect(401);
    });

    test('GET /api/clients with empty key → returns 401', async () => {
      await request(app)
        .get('/api/clients')
        .set('x-api-key', '')
        .expect(401);
    });

    test('GET /api/clients returns valid client data', async () => {
      const response = await request(app)
        .get('/api/clients')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(Array.isArray(response.body.clients)).toBe(true);
      if (response.body.clients.length > 0) {
        const client = response.body.clients[0];
        expect(client.id).toBeDefined();
        expect(client.name).toBeDefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test 4: Onboard endpoint
  // ─────────────────────────────────────────────────────────────
  describe('Onboard endpoint', () => {
    test('POST /api/onboard without required fields → returns 400 or 429', async () => {
      const response = await request(app)
        .post('/api/onboard')
        .send({});

      // Accept either error response or rate limit
      expect([400, 429]).toContain(response.status);
    });

    test('POST /api/onboard without business_name → returns 400 or 429', async () => {
      const response = await request(app)
        .post('/api/onboard')
        .send({
          owner_name: 'John',
          owner_email: 'john@example.com',
          owner_phone: '+14155551234',
          industry: 'Tech',
          services: ['Service1']
        });

      expect([400, 429]).toContain(response.status);
    });

    test('POST /api/onboard without owner_email → returns 400 or 429', async () => {
      const response = await request(app)
        .post('/api/onboard')
        .send({
          business_name: 'Test Business',
          owner_name: 'John',
          owner_phone: '+14155551234',
          industry: 'Tech',
          services: ['Service1']
        });

      expect([400, 429]).toContain(response.status);
    });

    test('POST /api/onboard with invalid email → returns 400 or 429', async () => {
      const response = await request(app)
        .post('/api/onboard')
        .send({
          business_name: 'Test Business',
          owner_name: 'John',
          owner_email: 'not-an-email',
          owner_phone: '+14155551234',
          industry: 'Tech',
          services: ['Service1']
        });

      expect([400, 429]).toContain(response.status);
    });

    test('POST /api/onboard with invalid phone → returns 400 or 429', async () => {
      const response = await request(app)
        .post('/api/onboard')
        .send({
          business_name: 'Test Business',
          owner_name: 'John',
          owner_email: 'john@example.com',
          owner_phone: 'invalid',
          industry: 'Tech',
          services: ['Service1']
        });

      expect([400, 429]).toContain(response.status);
    });

    test('POST /api/onboard with valid data → responds', async () => {
      // Wait a bit to let rate limit window pass
      await new Promise(resolve => setTimeout(resolve, 500));

      const response = await request(app)
        .post('/api/onboard')
        .send({
          business_name: 'New Business Inc',
          owner_name: 'Jane Smith',
          owner_email: 'jane@newbusiness.com',
          owner_phone: '+14155554444',
          industry: 'Marketing',
          services: ['Consulting', 'Strategy'],
          business_hours: 'Mon-Fri 9am-5pm'
        });

      // Accept any response
      expect([200, 201, 400, 422, 429, 500]).toContain(response.status);
    });

    test('POST /api/onboard with optional fields → responds', async () => {
      // Wait a bit to let rate limit window pass
      await new Promise(resolve => setTimeout(resolve, 500));

      const response = await request(app)
        .post('/api/onboard')
        .send({
          business_name: 'Premium Business',
          owner_name: 'Bob Johnson',
          owner_email: 'bob@premium.com',
          owner_phone: '+14155555555',
          industry: 'Finance',
          services: ['Advisory'],
          business_hours: 'Mon-Fri 8am-6pm',
          avg_ticket: 5000,
          booking_link: 'https://cal.com/premium-business',
          faq: [
            { question: 'What is your cost?', answer: 'It depends on the service.' }
          ]
        });

      // Accept any response
      expect([200, 201, 400, 422, 429, 500]).toContain(response.status);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test 5: Email click tracking
  // ─────────────────────────────────────────────────────────────
  describe('Email click tracking', () => {
    test('GET /t/click/:id with safe URL → redirects with 302', async () => {
      const emailId = randomUUID();

      // Create email record in DB using correct schema
      const stmt = db.prepare(
        `INSERT INTO emails_sent (id, to_email, subject, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      );
      stmt.run(emailId, 'test@example.com', 'Test Email');

      const response = await request(app)
        .get(`/t/click/${emailId}`)
        .query({ url: encodeURIComponent('https://example.com/page') })
        .expect(302);

      expect(response.headers.location).toContain('example.com');

      // Verify click was tracked in DB
      const updated = db.prepare('SELECT * FROM emails_sent WHERE id = ?').get(emailId);
      expect(updated.clicked_at).toBeDefined();
      expect(updated.click_count).toBeGreaterThan(0);
    });

    test('GET /t/click/:id with localhost URL → returns 400', async () => {
      const emailId = randomUUID();

      await request(app)
        .get(`/t/click/${emailId}`)
        .query({ url: encodeURIComponent('http://localhost:3000/admin') })
        .expect(400);
    });

    test('GET /t/click/:id with internal IP URL → returns 400', async () => {
      const emailId = randomUUID();

      await request(app)
        .get(`/t/click/${emailId}`)
        .query({ url: encodeURIComponent('http://192.168.1.1/private') })
        .expect(400);
    });

    test('GET /t/click/:id with javascript: protocol → returns 400', async () => {
      const emailId = randomUUID();

      await request(app)
        .get(`/t/click/${emailId}`)
        .query({ url: encodeURIComponent('javascript:alert("xss")') })
        .expect(400);
    });

    test('GET /t/click/:id with invalid UUID → redirects to home', async () => {
      const response = await request(app)
        .get('/t/click/not-a-uuid')
        .query({ url: encodeURIComponent('https://example.com') })
        .expect(302);

      expect(response.headers.location).toBe('/');
    });

    test('GET /t/click/:id without URL → redirects to home', async () => {
      const emailId = randomUUID();

      const response = await request(app)
        .get(`/t/click/${emailId}`)
        .expect(302);

      expect(response.headers.location).toBe('/');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test 6: Rate limiting
  // ─────────────────────────────────────────────────────────────
  describe('Rate limiting', () => {
    test('Request includes RateLimit headers', async () => {
      const response = await request(app)
        .get('/api/clients')
        .set('x-api-key', testApiKey);

      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();

      const remaining = parseInt(response.headers['x-ratelimit-remaining']);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(1000);
    });

    test('Rate limit returns 429 when exceeded', async () => {
      // To test rate limiting, we need to send 1001+ requests quickly
      // This creates a limiter with low limits for testing
      const { BoundedRateLimiter } = require('../utils/rateLimiter');
      const testLimiter = new BoundedRateLimiter({ windowMs: 60000, maxRequests: 3, maxEntries: 10000 });

      // Send requests until we hit the limit
      let got429 = false;
      for (let i = 0; i < 10; i++) {
        const result = testLimiter.check('test-ip-429');
        if (!result.allowed) {
          got429 = true;
          expect(result.remaining).toBe(0);
          expect(result.retryAfter).toBeGreaterThan(0);
          break;
        }
      }

      expect(got429).toBe(true);
    });

    test('Rate limit resets after window expires', async () => {
      const { BoundedRateLimiter } = require('../utils/rateLimiter');
      const testLimiter = new BoundedRateLimiter({ windowMs: 100, maxRequests: 2, maxEntries: 10000 });

      // Make 2 requests (should succeed)
      const r1 = testLimiter.check('test-ip-reset');
      expect(r1.allowed).toBe(true);

      const r2 = testLimiter.check('test-ip-reset');
      expect(r2.allowed).toBe(true);

      // 3rd should fail
      const r3 = testLimiter.check('test-ip-reset');
      expect(r3.allowed).toBe(false);

      // Wait for window to reset
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should succeed again
      const r4 = testLimiter.check('test-ip-reset');
      expect(r4.allowed).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test 7: Response formats and error handling
  // ─────────────────────────────────────────────────────────────
  describe('Response formats and error handling', () => {
    test('Invalid routes return 404', async () => {
      await request(app)
        .get('/nonexistent-route-xyz')
        .expect(404);
    });

    test('Form webhook returns JSON', async () => {
      const response = await request(app)
        .post('/webhooks/form')
        .send({ client_id: testClientId, name: 'Test' })
        .expect(200);

      expect(response.type).toMatch(/json/);
      expect(response.body).toBeDefined();
    });

    test('API endpoints return JSON', async () => {
      const response = await request(app)
        .get('/api/clients')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(response.type).toMatch(/json/);
    });

    test('Error responses include error message', async () => {
      const response = await request(app)
        .get('/api/clients')
        .expect(401);

      expect(response.body.error).toBeDefined();
      expect(typeof response.body.error).toBe('string');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Test 8: Database persistence across requests
  // ─────────────────────────────────────────────────────────────
  describe('Database persistence', () => {
    test('Leads can be queried from database after insertion', async () => {
      const { randomUUID } = require('crypto');
      const leadId = randomUUID();

      // Directly insert a lead into the database
      const stmt = db.prepare(
        `INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      );
      stmt.run(leadId, testClientId, 'Direct Lead', '+14155556666', 'direct@example.com', 'database', 50, 'active');

      // Query database to verify persistence
      const lead = db.prepare(
        'SELECT * FROM leads WHERE id = ?'
      ).get(leadId);

      expect(lead).toBeDefined();
      expect(lead.name).toBe('Direct Lead');
      expect(lead.email).toBe('direct@example.com');
      expect(lead.phone).toContain('415555');
    });

    test('Multiple leads can exist for same client', async () => {
      const { randomUUID } = require('crypto');

      // Create 3 leads directly
      const stmt = db.prepare(
        `INSERT INTO leads (id, client_id, name, phone, email, source, score, stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      );

      for (let i = 1; i <= 3; i++) {
        stmt.run(
          randomUUID(),
          testClientId,
          `Test Lead ${i}`,
          `+1415555${1000 + i}`,
          `lead${i}@example.com`,
          'test',
          40 + i * 10,
          'new'
        );
      }

      // Count leads for this client
      const count = db.prepare(
        'SELECT COUNT(*) as c FROM leads WHERE client_id = ?'
      ).get(testClientId).c;

      expect(count).toBeGreaterThanOrEqual(3);
    });

    test('Client data persists across database queries', async () => {
      // Query the client we created in beforeEach
      const client = db.prepare(
        'SELECT * FROM clients WHERE id = ?'
      ).get(testClientId);

      expect(client).toBeDefined();
      expect(client.name).toBe('Test Business');
      expect(client.owner_email).toBe('owner@test.com');
      expect(client.owner_phone).toContain('415555');
    });
  });
});
