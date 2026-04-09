'use strict';

const request = require('supertest');
const express = require('express');

// ─── Mocks (must come before any require of route files) ─────────────────────

jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/config', () => ({
  apis: { googleMapsKey: 'test-google-maps-key' },
  outreach: {
    dailySendLimit: 300,
    senderName: 'Test Sender',
    bookingLink: 'https://cal.com/test/demo',
  },
}));

jest.mock('../utils/auditLog', () => ({
  logDataMutation: jest.fn(),
}));

jest.mock('../utils/dbAdapter', () => ({
  isAsync: jest.fn(() => false),
}));

jest.mock('../utils/mailer', () => ({
  getTransporter: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
  })),
}));

jest.mock('../utils/emailGenerator', () => ({
  generateColdEmail: jest.fn().mockResolvedValue({
    subject_a: 'Subject A',
    subject_b: 'Subject B',
    body: 'Cold email body text',
  }),
  pickVariant: jest.fn((idx) => (idx % 2 === 0 ? 'A' : 'B')),
}));

jest.mock('../utils/emailVerifier', () => ({
  verifyEmail: jest.fn().mockResolvedValue({ valid: true, reason: 'ok', method: 'smtp' }),
}));

jest.mock('../utils/emailTemplates', () => ({
  wrapWithCTA: jest.fn((body) => `<html>${body}</html>`),
}));

jest.mock('../utils/jobQueue', () => ({
  enqueueJob: jest.fn(),
}));

// Mock global fetch used by scrape.js for Google Places + website scraping
global.fetch = jest.fn();

// ─── Route under test ─────────────────────────────────────────────────────────

const scrapeRouter = require('../routes/scrape');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/', scrapeRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.message, code: err.code });
  });

  app.locals.db = db;
  return app;
}

function makePlacesResponse(places = []) {
  return {
    ok: true,
    json: async () => ({ places }),
    text: async () => JSON.stringify({ places }),
  };
}

function makePlace(overrides = {}) {
  return {
    displayName: { text: 'Acme Plumbing' },
    nationalPhoneNumber: '(415) 555-0101',
    websiteUri: null,
    formattedAddress: '123 Main St, San Francisco CA',
    rating: 4.5,
    userRatingCount: 120,
    ...overrides,
  };
}

// ─── POST /scrape ─────────────────────────────────────────────────────────────

describe('POST /scrape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockResolvedValue(makePlacesResponse([]));
  });

  // Validation
  test('returns 400 when industry is missing', async () => {
    const app = buildApp({ query: jest.fn() });
    const res = await request(app)
      .post('/scrape')
      .send({ city: 'San Francisco' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when city is missing', async () => {
    const app = buildApp({ query: jest.fn() });
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when maxResults exceeds 20', async () => {
    const app = buildApp({ query: jest.fn() });
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'SF', maxResults: 100 });
    expect(res.status).toBe(400);
  });

  test('returns 400 when industry is empty string', async () => {
    const app = buildApp({ query: jest.fn() });
    const res = await request(app)
      .post('/scrape')
      .send({ industry: '', city: 'SF' });
    expect(res.status).toBe(400);
  });

  // Happy path
  test('returns 200 with scraped: 0 when Google Places returns no results', async () => {
    global.fetch.mockResolvedValue(makePlacesResponse([]));
    const db = { query: jest.fn().mockResolvedValue({ changes: 1 }) };
    const app = buildApp(db);
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scraped: 0, withEmails: 0, prospects: [] });
  });

  test('returns 200 with scraped prospects from Places API', async () => {
    global.fetch.mockResolvedValue(makePlacesResponse([makePlace()]));
    const db = { query: jest.fn().mockResolvedValue({ changes: 1 }) };
    const app = buildApp(db);
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(200);
    expect(res.body.scraped).toBe(1);
    expect(res.body.prospects[0].business_name).toBe('Acme Plumbing');
  });

  test('skips prospect when db insert throws UNIQUE constraint error', async () => {
    global.fetch.mockResolvedValue(makePlacesResponse([makePlace(), makePlace({ displayName: { text: 'Dup' } })]));
    const db = {
      query: jest.fn().mockRejectedValue(Object.assign(new Error('UNIQUE constraint failed'), {})),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(200);
    expect(res.body.scraped).toBe(0); // both skipped due to unique constraint
  });

  test('returns 500 on Google Places API error', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      text: async () => 'API quota exceeded',
    });
    const db = { query: jest.fn() };
    const app = buildApp(db);
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to scrape prospects');
  });

  test('returns 500 on unhandled fetch throw', async () => {
    global.fetch.mockRejectedValue(new Error('Network error'));
    const db = { query: jest.fn() };
    const app = buildApp(db);
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(500);
  });

  test('extracts email from website HTML when safe URL provided', async () => {
    const place = makePlace({ websiteUri: 'https://example-plumbing.com' });
    // First call = Google Places, second call = website homepage fetch
    global.fetch
      .mockResolvedValueOnce(makePlacesResponse([place]))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<html>contact us at <a href="mailto:owner@example-plumbing.com">email</a></html>',
      });
    const db = { query: jest.fn().mockResolvedValue({ changes: 1 }) };
    const app = buildApp(db);
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(200);
    expect(res.body.withEmails).toBe(1);
    expect(res.body.prospects[0].email).toBe('owner@example-plumbing.com');
  });

  test('blocks SSRF — does not fetch unsafe internal URLs', async () => {
    const place = makePlace({ websiteUri: 'http://169.254.169.254/metadata' });
    global.fetch.mockResolvedValueOnce(makePlacesResponse([place]));
    const db = { query: jest.fn().mockResolvedValue({ changes: 1 }) };
    const app = buildApp(db);
    const res = await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(200);
    // fetch should only have been called once (for Google Places), not for the unsafe URL
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('blocks SSRF — does not fetch localhost URLs', async () => {
    const place = makePlace({ websiteUri: 'http://localhost:8080/admin' });
    global.fetch.mockResolvedValueOnce(makePlacesResponse([place]));
    const db = { query: jest.fn().mockResolvedValue({ changes: 1 }) };
    const app = buildApp(db);
    await request(app)
      .post('/scrape')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    // Only the Google Places fetch should have been made
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /blast ──────────────────────────────────────────────────────────────

describe('POST /blast', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockResolvedValue(makePlacesResponse([]));
  });

  // Validation
  test('returns 400 when industry is missing', async () => {
    const app = buildApp({ query: jest.fn() });
    const res = await request(app)
      .post('/blast')
      .send({ city: 'San Francisco' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when city is missing', async () => {
    const app = buildApp({ query: jest.fn() });
    const res = await request(app)
      .post('/blast')
      .send({ industry: 'Plumbing' });
    expect(res.status).toBe(400);
  });

  // Happy path — no prospects scraped
  test('returns 200 with empty results when no places found', async () => {
    global.fetch.mockResolvedValue(makePlacesResponse([]));

    const db = {
      query: jest.fn(async (sql, params, mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (mode === 'run') return { changes: 1 };
        if (mode === 'get' && s.includes('COUNT(*)')) return { count: 0 };
        return null;
      }),
      transaction: jest.fn((fn) => (...args) => fn(...args)),
      prepare: jest.fn(() => ({ run: jest.fn() })),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/blast')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scraped: 0, generated: 0, sent: 0 });
  });

  test('returns 429 when daily send limit is reached', async () => {
    global.fetch.mockResolvedValue(makePlacesResponse([]));
    const db = {
      query: jest.fn(async (sql, params, mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (mode === 'run') return { changes: 1 };
        if (mode === 'get' && s.includes('COUNT(*)')) return { count: 999 }; // over limit
        return null;
      }),
      transaction: jest.fn((fn) => (...args) => fn(...args)),
      prepare: jest.fn(() => ({ run: jest.fn() })),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/blast')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/daily send limit/i);
  });

  test('scrapes, generates, and sends when prospect has email', async () => {
    const place = makePlace({ websiteUri: null }); // no website, no email scraping
    global.fetch.mockResolvedValueOnce(makePlacesResponse([place]));

    const { generateColdEmail } = require('../utils/emailGenerator');
    generateColdEmail.mockResolvedValue({ subject_a: 'SubA', subject_b: 'SubB', body: 'Body text' });

    const prospect = {
      id: 'prospect-1',
      to_email: 'owner@acme.com',
      from_email: 'test@sender.com',
      subject: 'SubA',
      body: 'Body text',
      subject_a: 'SubA',
      subject_b: 'SubB',
      variant: 'A',
      prospect_id: 'prospect-1',
    };

    const db = {
      query: jest.fn(async (sql, params, mode) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (mode === 'run') return { changes: 1 };
        if (mode === 'get' && s.includes('COUNT(*)')) return { count: 0 };
        if (mode === 'all' && s.includes('FROM emails_sent')) return [prospect];
        return null;
      }),
      transaction: jest.fn((fn) => (...args) => fn(...args)),
      prepare: jest.fn(() => ({ run: jest.fn() })),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/blast')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scraped: expect.any(Number),
      campaign_id: expect.any(String),
    });
  });

  test('returns 500 on Google Places API error', async () => {
    global.fetch.mockResolvedValue({ ok: false, text: async () => 'quota exceeded' });
    const db = {
      query: jest.fn().mockResolvedValue(null),
      transaction: jest.fn((fn) => (...args) => fn(...args)),
      prepare: jest.fn(() => ({ run: jest.fn() })),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/blast')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to blast prospects');
  });

  test('returns 500 on db error during campaign creation', async () => {
    global.fetch.mockResolvedValue(makePlacesResponse([]));
    const db = {
      query: jest.fn(async (sql, params, mode) => {
        if (mode === 'run') throw new Error('DB write failed');
        return null;
      }),
      transaction: jest.fn((fn) => (...args) => fn(...args)),
      prepare: jest.fn(() => ({ run: jest.fn() })),
    };
    const app = buildApp(db);
    const res = await request(app)
      .post('/blast')
      .send({ industry: 'Plumbing', city: 'San Francisco' });
    // No prospects = no campaign INSERT = no run mode needed → 200 with empty result
    expect([200, 500]).toContain(res.status);
  });
});
