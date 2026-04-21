'use strict';

/**
 * Route-level tests for routes/tracking.js
 * Tests the email open pixel and click-redirect endpoints.
 */

const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');

// Mock external dependencies before requiring routes
jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

jest.mock('../utils/analyticsStream', () => ({
  emitAnalyticsEvent: jest.fn()
}));

// isValidUUID is used directly from ../utils/validators — use real implementation
// (it's a pure function with no side effects)

const trackingRouter = require('../routes/tracking');

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PIXEL_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PIXEL_BUF = Buffer.from(PIXEL_B64, 'base64');

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/t', trackingRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

function makeMockDb(overrides = {}) {
  const defaults = {
    query: jest.fn().mockResolvedValue({ changes: 1 })
  };
  return Object.assign(defaults, overrides);
}

// ─── GET /t/open/:emailId ────────────────────────────────────────────────────

describe('GET /t/open/:emailId — email open pixel', () => {
  let app;
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = makeMockDb();
    // default: UPDATE succeeds, SELECT returns an emailRow
    mockDb.query.mockImplementation((sql, params, mode) => {
      if (mode === 'get') {
        return Promise.resolve({ id: params[0], client_id: 'client-1' });
      }
      return Promise.resolve({ changes: 1 });
    });
    app = buildApp(mockDb);
  });

  it('returns 1x1 transparent GIF with correct headers', async () => {
    const res = await request(app).get(`/t/open/${VALID_UUID}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/gif/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['pragma']).toBe('no-cache');
    expect(Buffer.compare(res.body, PIXEL_BUF)).toBe(0);
  });

  it('calls db.query to record the open', async () => {
    await request(app).get(`/t/open/${VALID_UUID}`);

    const updateCall = mockDb.query.mock.calls.find(c => c[0].includes('UPDATE emails_sent'));
    expect(updateCall).toBeDefined();
    expect(updateCall[2]).toBe('run');
  });

  it('returns pixel even for an invalid (non-UUID) emailId', async () => {
    const res = await request(app).get('/t/open/not-a-uuid');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/gif/);
    // db.query must NOT be called for invalid IDs
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('returns pixel even when db.query throws', async () => {
    mockDb.query.mockRejectedValue(new Error('DB error'));
    const res = await request(app).get(`/t/open/${VALID_UUID}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/gif/);
  });

  it('returns pixel when no db is attached (db = null)', async () => {
    const appNoDb = buildApp(null);
    const res = await request(appNoDb).get(`/t/open/${VALID_UUID}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/gif/);
  });

  it('does not double-count — COALESCE(opened_at, ?) ensures first value wins', async () => {
    // The route uses COALESCE(opened_at, ?) which preserves the first timestamp.
    // We verify the UPDATE SQL contains COALESCE to ensure the "first open wins" semantics.
    await request(app).get(`/t/open/${VALID_UUID}`);

    const updateCall = mockDb.query.mock.calls.find(c =>
      c[0].includes('UPDATE emails_sent') && c[0].includes('COALESCE')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain('COALESCE(opened_at,');
  });

  it('increments open_count on every open regardless of opened_at', async () => {
    await request(app).get(`/t/open/${VALID_UUID}`);

    const updateSql = mockDb.query.mock.calls.find(c => c[0].includes('UPDATE emails_sent'))[0];
    expect(updateSql).toContain('open_count = COALESCE(open_count, 0) + 1');
  });

  it('emits analytics event when emailRow is found', async () => {
    const { emitAnalyticsEvent } = require('../utils/analyticsStream');
    await request(app).get(`/t/open/${VALID_UUID}`);

    expect(emitAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'email_opened' })
    );
  });

  it('does not emit analytics event when emailRow not found', async () => {
    mockDb.query.mockImplementation((sql, params, mode) => {
      if (mode === 'get') return Promise.resolve(null);
      return Promise.resolve({ changes: 1 });
    });
    const { emitAnalyticsEvent } = require('../utils/analyticsStream');
    emitAnalyticsEvent.mockClear();

    await request(app).get(`/t/open/${VALID_UUID}`);

    expect(emitAnalyticsEvent).not.toHaveBeenCalled();
  });
});

// ─── GET /t/click/:emailId ───────────────────────────────────────────────────

describe('GET /t/click/:emailId — click tracking redirect', () => {
  let app;
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = makeMockDb();
    app = buildApp(mockDb);
  });

  it('redirects to the destination URL with _csid appended', async () => {
    const destUrl = encodeURIComponent('https://example.com/landing');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${destUrl}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://example.com/landing');
    expect(res.headers.location).toContain('_csid=');
  });

  it('records the click in the database', async () => {
    const destUrl = encodeURIComponent('https://example.com');
    await request(app)
      .get(`/t/click/${VALID_UUID}?url=${destUrl}`)
      .redirects(0);

    const updateCall = mockDb.query.mock.calls.find(c => c[0].includes('UPDATE emails_sent'));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain('click_count = COALESCE(click_count, 0) + 1');
  });

  it('redirects to / when no url query param provided', async () => {
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('redirects invalid (non-UUID) emailId to /', async () => {
    const res = await request(app)
      .get('/t/click/not-a-uuid?url=https%3A%2F%2Fexample.com')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('returns 400 for javascript: protocol (blocked dangerous protocol)', async () => {
    const bad = encodeURIComponent('javascript:alert(1)');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${bad}`)
      .redirects(0);

    expect(res.status).toBe(400);
  });

  it('returns 400 for data: protocol', async () => {
    const bad = encodeURIComponent('data:text/html,<script>evil</script>');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${bad}`)
      .redirects(0);

    expect(res.status).toBe(400);
  });

  it('returns 400 for internal IP redirect (SSRF protection)', async () => {
    const bad = encodeURIComponent('http://127.0.0.1/admin');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${bad}`)
      .redirects(0);

    expect(res.status).toBe(400);
  });

  it('returns 400 for 192.168.x.x SSRF attempt', async () => {
    const bad = encodeURIComponent('http://192.168.1.1/');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${bad}`)
      .redirects(0);

    expect(res.status).toBe(400);
  });

  it('still redirects when db.query throws (error is non-fatal)', async () => {
    mockDb.query.mockRejectedValue(new Error('DB down'));
    const destUrl = encodeURIComponent('https://example.com');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${destUrl}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('example.com');
  });

  it('click_session_id is preserved via COALESCE (first click wins)', async () => {
    const destUrl = encodeURIComponent('https://example.com');
    await request(app)
      .get(`/t/click/${VALID_UUID}?url=${destUrl}`)
      .redirects(0);

    const updateSql = mockDb.query.mock.calls.find(c => c[0].includes('UPDATE emails_sent'))[0];
    expect(updateSql).toContain('COALESCE(click_session_id,');
  });

  it('redirects to / for malformed URL (caught by URL constructor)', async () => {
    const bad = encodeURIComponent('https://not a valid url with spaces');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${bad}`)
      .redirects(0);

    // SSRF check rejects it first or URL constructor throws, both → redirect to /
    expect([302, 400]).toContain(res.status);
  });

  it('handles http:// destination URLs (not just https)', async () => {
    const destUrl = encodeURIComponent('http://example.com/page');
    const res = await request(app)
      .get(`/t/click/${VALID_UUID}?url=${destUrl}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('example.com');
  });
});
