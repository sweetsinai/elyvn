/**
 * Tests for routes/auth.js — JWT auth signup/login/refresh/me
 */

// Stable JWT_SECRET for token tests
process.env.JWT_SECRET = 'test-jwt-secret-key-for-unit-tests';

const crypto = require('crypto');

describe('auth routes', () => {
  let authRouter;
  let createToken;
  let verifyToken;
  let mockDb;
  let app;
  let request;

  function makeDb(overrides = {}) {
    const store = {};
    return {
      prepare: jest.fn((sql) => {
        if (sql.includes('SELECT id FROM clients WHERE owner_email')) {
          return { get: jest.fn(overrides.existingEmail ? () => ({ id: 'existing-id' }) : () => null) };
        }
        if (sql.includes('INSERT INTO clients')) {
          return { run: jest.fn() };
        }
        if (sql.includes('SELECT id, name, owner_email, password_hash')) {
          return {
            get: jest.fn((email) => {
              if (overrides.loginClient) return overrides.loginClient;
              return null;
            })
          };
        }
        if (sql.includes('SELECT id, name, owner_name, owner_email')) {
          return {
            get: jest.fn((id) => {
              if (overrides.meClient) return overrides.meClient;
              return null;
            })
          };
        }
        return { get: jest.fn(() => null), run: jest.fn(), all: jest.fn(() => []) };
      }),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

    authRouter = require('../routes/auth');
    createToken = authRouter.createToken;
    verifyToken = authRouter.verifyToken;

    const express = require('express');
    app = express();
    app.use(express.json());
    mockDb = makeDb();
    app.locals.db = mockDb;
    app.use('/auth', authRouter);

    request = require('supertest');
  });

  // ── POST /auth/signup ──

  describe('POST /auth/signup', () => {
    test('valid signup returns 201 with token and clientId', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'test@example.com', password: 'Password1', business_name: 'TestBiz' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.clientId).toBeDefined();
      expect(res.body.email).toBe('test@example.com');
      expect(res.body.business_name).toBe('TestBiz');
    });

    test('duplicate email returns 409', async () => {
      app.locals.db = makeDb({ existingEmail: true });
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'dup@example.com', password: 'Password1', business_name: 'Biz' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists/);
    });

    test('missing fields returns 400', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'a@b.com' });

      expect(res.status).toBe(400);
    });

    test('weak password (too short) returns 400', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'a@b.com', password: 'Ab1', business_name: 'X' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/8-128/);
    });

    test('password without number returns 400', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'a@b.com', password: 'abcdefgh', business_name: 'X' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/letter and one number/);
    });

    test('password without letter returns 400', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'a@b.com', password: '12345678', business_name: 'X' });

      expect(res.status).toBe(400);
    });

    test('invalid email format returns 400', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'not-an-email', password: 'Password1', business_name: 'X' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/email format/i);
    });
  });

  // ── POST /auth/login ──

  describe('POST /auth/login', () => {
    function makeLoginDb(client) {
      return makeDb({ loginClient: client });
    }

    test('valid login returns token', async () => {
      // Hash a known password
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync('Password1', salt, 64).toString('hex');
      const passwordHash = `${salt}:${hash}`;

      app.locals.db = makeLoginDb({
        id: 'client-1',
        name: 'Biz',
        owner_email: 'user@test.com',
        password_hash: passwordHash,
        plan: 'starter',
        subscription_status: 'active',
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'user@test.com', password: 'Password1' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.clientId).toBe('client-1');
    });

    test('wrong password returns 401', async () => {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync('Password1', salt, 64).toString('hex');

      app.locals.db = makeLoginDb({
        id: 'client-1',
        name: 'Biz',
        owner_email: 'user@test.com',
        password_hash: `${salt}:${hash}`,
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'user@test.com', password: 'WrongPass1' });

      expect(res.status).toBe(401);
    });

    test('nonexistent email returns 401', async () => {
      app.locals.db = makeLoginDb(null);

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'nobody@test.com', password: 'Password1' });

      expect(res.status).toBe(401);
    });

    test('missing fields returns 400', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'a@b.com' });

      expect(res.status).toBe(400);
    });
  });

  // ── POST /auth/refresh ──

  describe('POST /auth/refresh', () => {
    test('valid token returns new token', async () => {
      const token = createToken({ clientId: 'c1', email: 'a@b.com' });

      const res = await request(app)
        .post('/auth/refresh')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.token).not.toBe(token); // new token issued
    });

    test('expired token returns 401', async () => {
      // Manually craft an expired token
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({
        clientId: 'c1', email: 'a@b.com',
        iat: Date.now() - 200000, exp: Date.now() - 100000,
        iss: 'elyvn-api', aud: 'elyvn-dashboard'
      })).toString('base64url');
      const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
      const expiredToken = `${header}.${body}.${sig}`;

      const res = await request(app)
        .post('/auth/refresh')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
    });

    test('invalid token returns 401', async () => {
      const res = await request(app)
        .post('/auth/refresh')
        .set('Authorization', 'Bearer garbage.token.here');

      expect(res.status).toBe(401);
    });

    test('no token returns 401', async () => {
      const res = await request(app).post('/auth/refresh');
      expect(res.status).toBe(401);
    });
  });

  // ── GET /auth/me ──

  describe('GET /auth/me', () => {
    test('valid token returns user info', async () => {
      app.locals.db = makeDb({
        meClient: {
          id: 'c1', name: 'TestBiz', owner_name: 'Sohan',
          owner_email: 'a@b.com', owner_phone: '+1555', plan: 'growth',
          subscription_status: 'active', industry: 'tech', created_at: '2026-01-01',
        }
      });

      const token = createToken({ clientId: 'c1', email: 'a@b.com' });
      const res = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe('c1');
      expect(res.body.business_name).toBe('TestBiz');
      expect(res.body.plan).toBe('growth');
    });

    test('expired token returns 401', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({
        clientId: 'c1', email: 'a@b.com',
        iat: Date.now() - 200000, exp: Date.now() - 100000,
        iss: 'elyvn-api', aud: 'elyvn-dashboard'
      })).toString('base64url');
      const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${body}`).digest('base64url');

      const res = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${header}.${body}.${sig}`);

      expect(res.status).toBe(401);
    });

    test('no token returns 401', async () => {
      const res = await request(app).get('/auth/me');
      expect(res.status).toBe(401);
    });
  });

  // ── Token utility functions ──

  describe('createToken / verifyToken', () => {
    test('createToken produces verifiable token', () => {
      const token = createToken({ clientId: 'c1', email: 'x@y.com' });
      const payload = verifyToken(token);
      expect(payload).not.toBeNull();
      expect(payload.clientId).toBe('c1');
      expect(payload.email).toBe('x@y.com');
      expect(payload.iss).toBe('elyvn-api');
      expect(payload.aud).toBe('elyvn-dashboard');
    });

    test('verifyToken rejects tampered token', () => {
      const token = createToken({ clientId: 'c1', email: 'x@y.com' });
      const tampered = token.slice(0, -5) + 'XXXXX';
      expect(verifyToken(tampered)).toBeNull();
    });

    test('verifyToken rejects non-string input', () => {
      expect(verifyToken(null)).toBeNull();
      expect(verifyToken(123)).toBeNull();
      expect(verifyToken(undefined)).toBeNull();
    });

    test('verifyToken rejects token missing clientId', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({
        email: 'x@y.com', iat: Date.now(), exp: Date.now() + 86400000,
        iss: 'elyvn-api', aud: 'elyvn-dashboard'
      })).toString('base64url');
      const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
      expect(verifyToken(`${header}.${body}.${sig}`)).toBeNull();
    });

    test('verifyToken rejects none algorithm', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({
        clientId: 'c1', iat: Date.now(), exp: Date.now() + 86400000,
      })).toString('base64url');
      expect(verifyToken(`${header}.${body}.`)).toBeNull();
    });
  });
});
