'use strict';

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { csrfProtection } = require('../middleware/csrf');

// ─── helpers ────────────────────────────────────────────────────────────────

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/some-endpoint',
    headers: {},
    ip: '127.0.0.1',
    clientId: undefined,
    isAdmin: undefined,
    isJwtAuth: undefined,
    ...overrides,
  };
}

function makeRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

// ─── safe methods pass through ──────────────────────────────────────────────

describe('CSRF — safe HTTP methods', () => {
  const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

  it.each(SAFE_METHODS)('%s passes without any auth checks', (method) => {
    const next = jest.fn();
    const req = makeReq({ method });
    const res = makeRes();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── state-changing methods in development ───────────────────────────────────

describe('CSRF — development mode (NODE_ENV=test)', () => {
  // NODE_ENV is "test" in Jest — which is !== "production", so the middleware
  // logs a warning and calls next() rather than returning 403.

  it('POST without any auth/header/origin calls next with a warning', () => {
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({ method: 'POST', path: '/api/leads' });

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('PUT without any auth/header/origin calls next', () => {
    const next = jest.fn();
    csrfProtection(makeReq({ method: 'PUT', path: '/api/leads/1' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('DELETE without any auth/header/origin calls next', () => {
    const next = jest.fn();
    csrfProtection(makeReq({ method: 'DELETE', path: '/api/leads/1' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('PATCH without any auth/header/origin calls next', () => {
    const next = jest.fn();
    csrfProtection(makeReq({ method: 'PATCH', path: '/api/leads/1' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

// ─── production mode returns 403 ────────────────────────────────────────────

describe('CSRF — production mode blocks unauthenticated state-changing requests', () => {
  const origEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
  });

  it('POST without auth token/header/origin returns 403', () => {
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({ method: 'POST', path: '/api/leads' });

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CSRF_REJECTED' })
    );
  });

  it('POST with clientId set passes through', () => {
    const next = jest.fn();
    const req = makeReq({ method: 'POST', clientId: 'client-abc' });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('POST with isAdmin=true passes through', () => {
    const next = jest.fn();
    const req = makeReq({ method: 'POST', isAdmin: true });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('POST with isJwtAuth=true passes through', () => {
    const next = jest.fn();
    const req = makeReq({ method: 'POST', isJwtAuth: true });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('POST with X-Requested-With header passes through', () => {
    const next = jest.fn();
    const req = makeReq({
      method: 'POST',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('POST with allowed origin passes through', () => {
    const next = jest.fn();
    const origCors = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = 'https://app.elyvn.com,https://staging.elyvn.com';

    const req = makeReq({
      method: 'POST',
      headers: { origin: 'https://app.elyvn.com' },
    });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
    process.env.CORS_ORIGINS = origCors;
  });

  it('POST with disallowed origin returns 403', () => {
    const next = jest.fn();
    const res = makeRes();
    const origCors = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = 'https://app.elyvn.com';

    const req = makeReq({
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });

    csrfProtection(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    process.env.CORS_ORIGINS = origCors;
  });

  it('POST with origin header but empty CORS_ORIGINS returns 403 in production', () => {
    const next = jest.fn();
    const res = makeRes();
    const origCors = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = '';

    const req = makeReq({
      method: 'POST',
      headers: { origin: 'https://any-origin.com' },
    });

    csrfProtection(req, res, next);

    // In production with CORS_ORIGINS empty and an origin header,
    // the "no allowed list" lenient check is dev-only → 403
    expect(res.status).toHaveBeenCalledWith(403);
    process.env.CORS_ORIGINS = origCors;
  });
});

// ─── webhook prefixes are excluded ──────────────────────────────────────────

describe('CSRF — webhook paths are excluded', () => {
  const WEBHOOK_PATHS = [
    '/webhooks/retell',
    '/retell-webhook',
    '/webhooks/legacySms',
    '/webhooks/twilio',
    '/webhooks/calcom',
    '/webhooks/telegram',
    '/webhooks/form',
    '/billing/webhook',
  ];

  // Run these in "production" so we know they bypass the 403 check
  const origEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
  });

  it.each(WEBHOOK_PATHS)(
    'POST to %s is skipped (webhook exclusion)',
    (path) => {
      const next = jest.fn();
      const req = makeReq({ method: 'POST', path });

      csrfProtection(req, makeRes(), next);

      expect(next).toHaveBeenCalled();
    }
  );

  it('webhook path check is case-insensitive', () => {
    const next = jest.fn();
    const req = makeReq({ method: 'POST', path: '/WEBHOOKS/TWILIO' });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('webhook sub-paths are also excluded', () => {
    const next = jest.fn();
    const req = makeReq({ method: 'POST', path: '/webhooks/twilio/status' });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });
});

// ─── origin header — dev leniency ───────────────────────────────────────────

describe('CSRF — origin header in non-production with empty CORS_ORIGINS', () => {
  it('allows through when CORS_ORIGINS is empty and NODE_ENV is not production', () => {
    const next = jest.fn();
    const origCors = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = '';

    const req = makeReq({
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });

    csrfProtection(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
    process.env.CORS_ORIGINS = origCors;
  });
});
