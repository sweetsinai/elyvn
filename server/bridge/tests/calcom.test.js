'use strict';

/**
 * Route-level tests for routes/calcom-webhook.js
 * Tests the Cal.com webhook handler (booking created/rescheduled/cancelled).
 */

const request = require('supertest');
const express = require('express');
const { createHmac } = require('crypto');
const { randomUUID } = require('crypto');

// Mock all side-effect utilities before requiring the route
jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

jest.mock('../utils/eventStore', () => ({
  appendEvent: jest.fn(),
  Events: { AppointmentBooked: 'AppointmentBooked' }
}));

jest.mock('../utils/auditLog', () => ({
  logDataMutation: jest.fn()
}));

jest.mock('../utils/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue(true)
}));

jest.mock('../utils/appointmentReminders', () => ({
  scheduleReminders: jest.fn()
}));

jest.mock('../utils/jobQueue', () => ({
  enqueueJob: jest.fn().mockResolvedValue(true),
  cancelJobs: jest.fn()
}));

jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue(true)
}));

jest.mock('../utils/webhookQueue', () => ({
  enqueue: jest.fn().mockResolvedValue(true)
}));

const calcomRouter = require('../routes/calcom-webhook');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BOOKING_ID = 'cal-booking-123';
const CLIENT_ID = randomUUID();
const APPT_ID = randomUUID();

function makeClient(overrides = {}) {
  return {
    id: CLIENT_ID,
    name: 'Test Biz',
    business_name: 'Test Biz',
    owner_email: 'owner@testbiz.com',
    is_active: 1,
    twilio_phone: '+15005550006',
    phone_number: '+15005550006',
    telegram_chat_id: '12345',
    google_review_link: null,
    booking_webhook_url: null,
    ...overrides
  };
}

function makeBookingPayload(overrides = {}) {
  return {
    bookingId: BOOKING_ID,
    uid: 'uid-abc',
    title: 'Demo Call',
    startTime: new Date(Date.now() + 86400000).toISOString(),
    endTime: new Date(Date.now() + 90000000).toISOString(),
    attendees: [{ name: 'Jane Doe', email: 'jane@prospect.com', phone: '+14155551234' }],
    organizer: { email: 'owner@testbiz.com' },
    metadata: {},
    ...overrides
  };
}

/**
 * Build a mock db that supports query(sql, params, mode) and
 * handles the sequences of calls calcom-webhook makes.
 */
function makeMockDb(clientRow = makeClient(), extraHandlers = {}) {
  const mockDb = {
    _calls: [],
    query: jest.fn(async (sql, params = [], mode = 'all') => {
      const s = sql.replace(/\s+/g, ' ').trim();

      // Allow caller-supplied overrides first
      if (extraHandlers.query) {
        const result = await extraHandlers.query(s, params, mode);
        if (result !== undefined) return result;
      }

      // Idempotency check: SELECT id FROM appointments WHERE calcom_booking_id
      if (s.includes('FROM appointments') && s.includes('calcom_booking_id') && mode === 'get') {
        return null; // not yet processed → proceed
      }

      // Client lookup by owner email
      if (s.includes('FROM clients') && s.includes('owner_email') && mode === 'get') {
        return clientRow;
      }

      // Client lookup by id (for rescheduled review request)
      if (s.includes('FROM clients') && s.includes('WHERE id') && mode === 'get') {
        return clientRow;
      }

      // Prospect lookup
      if (s.includes('FROM prospects') && mode === 'get') {
        return null;
      }

      // Lead lookup
      if (s.includes('FROM leads') && mode === 'get') {
        return null;
      }

      // Appointment lookup for reschedule
      if (s.includes('FROM appointments') && mode === 'get') {
        return {
          id: APPT_ID,
          client_id: CLIENT_ID,
          phone: '+14155551234',
          name: 'Jane Doe',
          service: 'Demo Call'
        };
      }

      // emails_sent prospect lookup
      if (s.includes('FROM emails_sent') && mode === 'get') {
        return null;
      }

      // INSERT / UPDATE / job_queue
      if (mode === 'run') return { changes: 1, lastInsertRowid: 1 };

      return [];
    })
  };
  return mockDb;
}

function buildApp(db, secret = undefined) {
  if (secret !== undefined) {
    process.env.CALCOM_WEBHOOK_SECRET = secret;
  } else {
    delete process.env.CALCOM_WEBHOOK_SECRET;
  }

  // Force a fresh require of the router so middleware captures the new env
  jest.resetModules();
  // Re-apply mocks after resetModules
  jest.mock('../utils/logger', () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
  }));
  jest.mock('../utils/eventStore', () => ({
    appendEvent: jest.fn(),
    Events: { AppointmentBooked: 'AppointmentBooked' }
  }));
  jest.mock('../utils/auditLog', () => ({
    logDataMutation: jest.fn()
  }));
  jest.mock('../utils/sms', () => ({
    sendSMS: jest.fn().mockResolvedValue(true)
  }));
  jest.mock('../utils/appointmentReminders', () => ({
    scheduleReminders: jest.fn()
  }));
  jest.mock('../utils/jobQueue', () => ({
    enqueueJob: jest.fn().mockResolvedValue(true),
    cancelJobs: jest.fn()
  }));
  jest.mock('../utils/telegram', () => ({
    sendMessage: jest.fn().mockResolvedValue(true)
  }));
  jest.mock('../utils/webhookQueue', () => ({
    enqueue: jest.fn().mockResolvedValue(true)
  }));

  const router = require('../routes/calcom-webhook');

  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/webhooks/calcom', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  });
  return app;
}

function signBody(body, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

// ─── Tests: no signature (dev mode) ─────────────────────────────────────────

describe('Cal.com webhook — no CALCOM_WEBHOOK_SECRET (dev/test mode)', () => {
  let app;
  let db;

  beforeEach(() => {
    delete process.env.CALCOM_WEBHOOK_SECRET;
    db = makeMockDb();
    app = buildApp(db);
  });

  afterEach(() => {
    delete process.env.CALCOM_WEBHOOK_SECRET;
  });

  it('responds 200 immediately for BOOKING_CREATED', async () => {
    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    const res = await request(app).post('/webhooks/calcom').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('responds 200 immediately for BOOKING_CANCELLED', async () => {
    const body = { triggerEvent: 'BOOKING_CANCELLED', payload: { bookingId: BOOKING_ID } };
    const res = await request(app).post('/webhooks/calcom').send(body);
    expect(res.status).toBe(200);
  });

  it('responds 200 immediately for BOOKING_RESCHEDULED', async () => {
    const body = {
      triggerEvent: 'BOOKING_RESCHEDULED',
      payload: {
        bookingId: BOOKING_ID,
        startTime: new Date(Date.now() + 172800000).toISOString(),
        endTime: new Date(Date.now() + 176400000).toISOString()
      }
    };
    const res = await request(app).post('/webhooks/calcom').send(body);
    expect(res.status).toBe(200);
  });

  it('responds 200 and returns received:true even when triggerEvent is missing', async () => {
    const res = await request(app)
      .post('/webhooks/calcom')
      .send({ payload: makeBookingPayload() });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('responds 200 and returns received:true even when payload is missing', async () => {
    const res = await request(app)
      .post('/webhooks/calcom')
      .send({ triggerEvent: 'BOOKING_CREATED' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('responds 200 for unknown triggerEvent', async () => {
    const res = await request(app)
      .post('/webhooks/calcom')
      .send({ triggerEvent: 'UNKNOWN_EVENT', payload: {} });
    expect(res.status).toBe(200);
  });

  it('creates an appointment row on BOOKING_CREATED', async () => {
    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    await request(app).post('/webhooks/calcom').send(body);

    // Give fire-and-forget async operations a tick to settle
    await new Promise(r => setImmediate(r));

    const insertCall = db.query.mock.calls.find(c =>
      c[0].includes('INSERT INTO appointments')
    );
    expect(insertCall).toBeDefined();
  });

  it('updates appointment status to cancelled on BOOKING_CANCELLED', async () => {
    const body = { triggerEvent: 'BOOKING_CANCELLED', payload: { bookingId: BOOKING_ID } };
    await request(app).post('/webhooks/calcom').send(body);
    await new Promise(r => setImmediate(r));

    const updateCall = db.query.mock.calls.find(c =>
      c[0].includes("status = 'cancelled'") && c[0].includes('appointments')
    );
    expect(updateCall).toBeDefined();
  });

  it('updates appointment datetime on BOOKING_RESCHEDULED', async () => {
    const newStart = new Date(Date.now() + 172800000).toISOString();
    const body = {
      triggerEvent: 'BOOKING_RESCHEDULED',
      payload: { bookingId: BOOKING_ID, startTime: newStart }
    };
    await request(app).post('/webhooks/calcom').send(body);
    await new Promise(r => setImmediate(r));

    const updateCall = db.query.mock.calls.find(c =>
      c[0].includes('UPDATE appointments') && c[0].includes('datetime = ?')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe(newStart);
  });

  it('is idempotent — skips processing if booking already exists', async () => {
    // Return an existing appointment for the idempotency check
    const idempotentDb = makeMockDb(makeClient(), {
      query: (sql, params, mode) => {
        if (sql.includes('FROM appointments') && sql.includes('calcom_booking_id') && mode === 'get') {
          return { id: APPT_ID }; // already processed
        }
        return undefined;
      }
    });

    const idempotentApp = buildApp(idempotentDb);
    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    await request(idempotentApp).post('/webhooks/calcom').send(body);
    await new Promise(r => setImmediate(r));

    // INSERT INTO appointments should NOT be called
    const insertCall = idempotentDb.query.mock.calls.find(c =>
      c[0].includes('INSERT INTO appointments')
    );
    expect(insertCall).toBeUndefined();
  });

  it('skips processing when no matching client found', async () => {
    const noClientDb = makeMockDb(null); // client lookup returns null
    const noClientApp = buildApp(noClientDb);

    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    await request(noClientApp).post('/webhooks/calcom').send(body);
    await new Promise(r => setImmediate(r));

    const insertCall = noClientDb.query.mock.calls.find(c =>
      c[0].includes('INSERT INTO appointments')
    );
    expect(insertCall).toBeUndefined();
  });

  it('upserts lead to booked stage when phone present', async () => {
    // No existing lead → creates new one
    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    await request(app).post('/webhooks/calcom').send(body);
    await new Promise(r => setImmediate(r));

    const leadInsert = db.query.mock.calls.find(c =>
      c[0].includes('INSERT INTO leads') && c[0].includes("'booked'")
    );
    expect(leadInsert).toBeDefined();
  });

  it('updates existing lead to booked when one already exists', async () => {
    const existingLeadDb = makeMockDb(makeClient(), {
      query: (sql, params, mode) => {
        if (sql.includes('FROM leads') && mode === 'get') {
          return { id: randomUUID(), client_id: CLIENT_ID, stage: 'contacted' };
        }
        return undefined;
      }
    });
    const existingLeadApp = buildApp(existingLeadDb);

    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    await request(existingLeadApp).post('/webhooks/calcom').send(body);
    await new Promise(r => setImmediate(r));

    const leadUpdate = existingLeadDb.query.mock.calls.find(c =>
      c[0].includes('UPDATE leads') && c[0].includes("stage = 'booked'")
    );
    expect(leadUpdate).toBeDefined();
  });
});

// ─── Tests: with CALCOM_WEBHOOK_SECRET ──────────────────────────────────────

describe('Cal.com webhook — with CALCOM_WEBHOOK_SECRET', () => {
  const SECRET = 'super-secret-calcom-webhook-key';
  let app;
  let db;

  beforeEach(() => {
    process.env.CALCOM_WEBHOOK_SECRET = SECRET;
    db = makeMockDb();
    app = buildApp(db, SECRET);
  });

  afterEach(() => {
    delete process.env.CALCOM_WEBHOOK_SECRET;
  });

  it('accepts request with valid signature', async () => {
    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    const sig = signBody(body, SECRET);
    const res = await request(app)
      .post('/webhooks/calcom')
      .set('x-cal-signature-256', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('rejects request with missing signature — returns 401', async () => {
    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    const res = await request(app).post('/webhooks/calcom').send(body);

    expect(res.status).toBe(401);
  });

  it('rejects request with wrong signature — returns 401', async () => {
    const body = { triggerEvent: 'BOOKING_CREATED', payload: makeBookingPayload() };
    const res = await request(app)
      .post('/webhooks/calcom')
      .set('x-cal-signature-256', 'deadbeef1234567890abcdef')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('rejects request with old timestamp — returns 400 (replay attack)', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const body = {
      triggerEvent: 'BOOKING_CREATED',
      payload: makeBookingPayload(),
      createdAt: oldTimestamp
    };
    const sig = signBody(body, SECRET);
    const res = await request(app)
      .post('/webhooks/calcom')
      .set('x-cal-signature-256', sig)
      .set('x-cal-timestamp', oldTimestamp)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('accepts request with recent timestamp', async () => {
    const recentTimestamp = new Date().toISOString();
    const body = {
      triggerEvent: 'BOOKING_CANCELLED',
      payload: { bookingId: BOOKING_ID },
      createdAt: recentTimestamp
    };
    const sig = signBody(body, SECRET);
    const res = await request(app)
      .post('/webhooks/calcom')
      .set('x-cal-signature-256', sig)
      .set('x-cal-timestamp', recentTimestamp)
      .send(body);

    expect(res.status).toBe(200);
  });
});
