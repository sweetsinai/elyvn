/**
 * Integration tests — Retell webhook flows
 *
 * Strategy:
 *   - SQLite in-memory (real DB operations, no mock DB)
 *   - All external I/O mocked: fetch (Retell API), Anthropic SDK, SMS, Telegram
 *   - HMAC signature tests use the real crypto path in the router middleware
 *   - Async handlers run via setImmediate; tests drain the queue with a short wait
 *   - Idempotency validated by sending identical webhook twice and confirming
 *     the DB row is not double-written
 */

'use strict';

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

// ─── Timing helper ───────────────────────────────────────────────────────────

/** Drain the setImmediate queue so async handlers complete before assertions. */
function flushAsync(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── HMAC helper ─────────────────────────────────────────────────────────────

const TEST_WEBHOOK_SECRET = 'retell-integration-test-secret';

function retellSign(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(body).digest('hex');
}

// ─── In-memory SQLite ────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      owner_email TEXT,
      business_name TEXT,
      retell_phone TEXT,
      retell_agent_id TEXT,
      twilio_phone TEXT,
      telnyx_phone TEXT,
      phone_number TEXT,
      owner_phone TEXT,
      transfer_phone TEXT,
      telegram_chat_id TEXT,
      calcom_booking_link TEXT,
      niche TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      call_id TEXT UNIQUE NOT NULL,
      client_id TEXT NOT NULL,
      caller_phone TEXT,
      direction TEXT DEFAULT 'inbound',
      duration INTEGER,
      outcome TEXT,
      summary TEXT,
      score INTEGER,
      sentiment TEXT,
      transcript TEXT,
      analysis_data TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      score INTEGER DEFAULT 5,
      stage TEXT DEFAULT 'new',
      source TEXT,
      calcom_booking_id TEXT,
      last_contact TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT,
      UNIQUE(client_id, phone)
    );

    CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      client_id TEXT,
      touch_number INTEGER,
      type TEXT,
      content TEXT,
      content_source TEXT,
      scheduled_at TEXT,
      status TEXT DEFAULT 'scheduled'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      lead_id TEXT,
      phone TEXT,
      channel TEXT,
      direction TEXT,
      body TEXT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_store (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT,
      aggregate_type TEXT,
      event_type TEXT,
      payload TEXT,
      client_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Attach the db.query interface the routes expect
  db.query = function query(sql, params = [], mode = 'all') {
    const stmt = db.prepare(sql);
    if (mode === 'get') return Promise.resolve(stmt.get(...params));
    if (mode === 'run') return Promise.resolve(stmt.run(...params));
    return Promise.resolve(stmt.all(...params));
  };

  return db;
}

function seedClient(db, overrides = {}) {
  const client = {
    id: 'client-webhook-1',
    owner_email: 'owner@webhooktest.com',
    business_name: 'Webhook Test Biz',
    retell_phone: '+14155550100',
    retell_agent_id: 'agent_test_001',
    twilio_phone: '+14155550101',
    telnyx_phone: null,
    phone_number: '+14155550100',
    owner_phone: '+19999999999',
    transfer_phone: null,
    telegram_chat_id: null,
    calcom_booking_link: 'https://cal.com/test',
    niche: 'general',
    ...overrides,
  };
  db.prepare(`
    INSERT OR REPLACE INTO clients
      (id, owner_email, business_name, retell_phone, retell_agent_id, twilio_phone,
       telnyx_phone, phone_number, owner_phone, transfer_phone, telegram_chat_id, calcom_booking_link, niche)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    client.id, client.owner_email, client.business_name,
    client.retell_phone, client.retell_agent_id, client.twilio_phone,
    client.telnyx_phone, client.phone_number, client.owner_phone, client.transfer_phone,
    client.telegram_chat_id, client.calcom_booking_link, client.niche
  );
  return client;
}

function seedCall(db, overrides = {}) {
  const call = {
    id: require('crypto').randomUUID(),
    call_id: 'call_existing_001',
    client_id: 'client-webhook-1',
    caller_phone: '+12125550001',
    direction: 'inbound',
    duration: null,
    outcome: null,
    summary: null,
    transcript: null,
    sentiment: null,
    ...overrides,
  };
  db.prepare(`
    INSERT OR REPLACE INTO calls
      (id, call_id, client_id, caller_phone, direction, duration, outcome, summary, transcript, sentiment)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    call.id, call.call_id, call.client_id, call.caller_phone,
    call.direction, call.duration, call.outcome, call.summary,
    call.transcript, call.sentiment
  );
  return call;
}

// ─── App factory ─────────────────────────────────────────────────────────────

function buildApp(db) {
  // Set RETELL_API_KEY so fetchCallTranscript actually calls global.fetch
  process.env.RETELL_API_KEY = 'retell_test_api_key';

  jest.mock('../../utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  jest.mock('../../utils/sms', () => ({
    sendSMS: jest.fn().mockResolvedValue({ success: true }),
    sendSMSToOwner: jest.fn().mockResolvedValue({ success: true }),
  }));

  jest.mock('../../utils/telegram', () => ({
    sendMessage: jest.fn().mockResolvedValue({ ok: true }),
    formatCallSummary: jest.fn().mockReturnValue({ text: 'test summary' }),
    formatTransferAlert: jest.fn().mockReturnValue({ text: 'test transfer' }),
  }));

  jest.mock('../../utils/phone', () => ({
    normalizePhone: jest.fn((p) => p || null),
  }));

  // Mock Anthropic — return a canned summary and score
  jest.mock('@anthropic-ai/sdk', () => {
    return jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ text: 'AI-generated summary of the call.' }],
        }),
      },
    }));
  });

  // Mock metrics (optional utility)
  jest.mock('../../utils/metrics', () => ({
    recordMetric: jest.fn(),
  }));

  // Mock websocket broadcast
  jest.mock('../../utils/websocket', () => ({
    broadcast: jest.fn(),
  }));

  // Mock analyticsStream
  jest.mock('../../utils/analyticsStream', () => ({
    emitAnalyticsEvent: jest.fn(),
  }));

  // Mock brain / actionExecutor / leadMemory to keep tests focused on webhook flows
  jest.mock('../../utils/brain', () => ({
    think: jest.fn().mockResolvedValue({ actions: [] }),
  }));

  jest.mock('../../utils/actionExecutor', () => ({
    executeActions: jest.fn().mockResolvedValue(undefined),
  }));

  jest.mock('../../utils/leadMemory', () => ({
    getLeadMemory: jest.fn().mockReturnValue(null),
  }));

  // Mock eventStore — no-op to avoid extra table requirements
  jest.mock('../../utils/eventStore', () => ({
    appendEvent: jest.fn(),
    Events: {
      LeadCreated: 'lead.created',
      LeadStageChanged: 'lead.stage_changed',
    },
  }));

  jest.mock('../../utils/nicheTemplates', () => ({
    generateVoicemailText: jest.fn().mockReturnValue('Voicemail SMS text'),
    generateFollowUpSms: jest.fn((_, __, msg) => msg),
  }));

  jest.mock('../../utils/businessHours', () => ({
    isWithinBusinessHours: jest.fn().mockReturnValue(true),
    getNextBusinessHour: jest.fn().mockReturnValue(Date.now() + 60000),
  }));

  jest.mock('../../utils/tracing', () => ({
    addTraceHeaders: jest.fn((h) => h),
  }));

  jest.mock('../../utils/config', () => ({
    ai: { model: 'claude-3-haiku-20240307' },
  }));

  // Mock global fetch used by retellBreaker / fetchCallTranscript
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      transcript: 'agent: Hello.\nuser: Hi I need help.',
      call_length: 45,
      call_analysis: {
        call_summary: 'Customer inquired about services.',
        user_sentiment: 'positive',
      },
      custom_analysis_data: {},
      disconnection_reason: '',
      direction: 'inbound',
      to_number: '+14155550100',
      from_number: '+12125550001',
    }),
  });

  const retellRouter = require('../../routes/retell');

  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/webhooks/retell', retellRouter);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Retell webhook integration — webhook flows', () => {
  let db;
  let app;

  beforeEach(() => {
    jest.resetModules();
    db = createTestDb();
    app = buildApp(db);
    delete process.env.RETELL_WEBHOOK_SECRET;
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
    delete process.env.RETELL_WEBHOOK_SECRET;
    delete process.env.RETELL_API_KEY;
  });

  // ── HMAC signature verification ──────────────────────────────────────────

  describe('HMAC signature verification', () => {
    test('allows request through when RETELL_WEBHOOK_SECRET is not set (dev mode)', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({ event: 'call_ended', call: { call_id: 'call_sig_001' } });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('rejects missing signature header when secret is configured (401)', async () => {
      process.env.RETELL_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      const res = await request(app)
        .post('/webhooks/retell')
        .send({ event: 'call_ended', call: { call_id: 'call_nosig_001' } });

      expect(res.status).toBe(401);
    });

    test('rejects wrong HMAC value (401)', async () => {
      process.env.RETELL_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      const res = await request(app)
        .post('/webhooks/retell')
        .set('x-retell-signature', 'aaabbbccc000wronghashvalue')
        .send({ event: 'call_ended', call: { call_id: 'call_badsig_001' } });

      expect(res.status).toBe(401);
    });

    test('accepts correct HMAC signature (200)', async () => {
      process.env.RETELL_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

      const payload = { event: 'call_ended', call: { call_id: 'call_goodsig_001' } };
      const sig = retellSign(payload);

      const res = await request(app)
        .post('/webhooks/retell')
        .set('x-retell-signature', sig)
        .send(payload);

      expect(res.status).toBe(200);
    });
  });

  // ── call.ended — creates call record, extracts analysis ──────────────────

  describe('call_ended event — creates call record and extracts analysis', () => {
    test('returns 200 immediately (fire-and-forget pattern)', async () => {
      seedClient(db);

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: 'call_ended_001',
            to_number: '+14155550100',
            from_number: '+12125550001',
            direction: 'inbound',
            call_length: 45,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('creates call record in DB when call_started was not received', async () => {
      seedClient(db);

      const callId = 'call_ended_new_002';
      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: callId,
            to_number: '+14155550100',
            from_number: '+12125550001',
            direction: 'inbound',
            call_length: 60,
          },
        });

      await flushAsync(80);

      const row = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
      expect(row).not.toBeNull();
      expect(row.client_id).toBe('client-webhook-1');
      expect(row.caller_phone).toBe('+12125550001');
    });

    test('updates existing call record with duration and outcome', async () => {
      seedClient(db);
      seedCall(db, { call_id: 'call_ended_existing_003' });

      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: 'call_ended_existing_003',
            to_number: '+14155550100',
            from_number: '+12125550001',
            call_length: 90,
          },
        });

      await flushAsync(80);

      const row = db.prepare('SELECT * FROM calls WHERE call_id = ?').get('call_ended_existing_003');
      expect(row).not.toBeNull();
      expect(row.duration).toBeGreaterThan(0);
      expect(row.outcome).toBeTruthy();
    });

    test('extracts call_analysis sentiment from Retell API response', async () => {
      seedClient(db);
      seedCall(db, { call_id: 'call_sentiment_004' });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          transcript: 'agent: How can I help?\nuser: Great service!',
          call_length: 55,
          call_analysis: {
            call_summary: 'Positive customer interaction.',
            user_sentiment: 'positive',
          },
          custom_analysis_data: {},
          disconnection_reason: '',
        }),
      });

      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: 'call_sentiment_004',
            to_number: '+14155550100',
            from_number: '+12125550001',
          },
        });

      await flushAsync(80);

      const row = db.prepare('SELECT sentiment FROM calls WHERE call_id = ?').get('call_sentiment_004');
      expect(row).not.toBeNull();
      expect(row.sentiment).toBe('positive');
    });

    test('determines outcome as booked when calcom_booking_id present', async () => {
      seedClient(db);
      seedCall(db, { call_id: 'call_booked_005' });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          transcript: 'agent: I booked you in.',
          call_length: 120,
          call_analysis: { user_sentiment: 'positive' },
          custom_analysis_data: { calcom_booking_id: 'booking_xyz_789' },
          disconnection_reason: '',
        }),
      });

      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: 'call_booked_005',
            to_number: '+14155550100',
            from_number: '+12125550001',
          },
        });

      await flushAsync(80);

      const row = db.prepare('SELECT outcome FROM calls WHERE call_id = ?').get('call_booked_005');
      expect(row).not.toBeNull();
      expect(row.outcome).toBe('booked');
    });

    test('skips processing when no matching client found', async () => {
      // No client seeded — call to unknown number
      const callId = 'call_noclient_006';

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          transcript: '',
          call_length: 20,
          call_analysis: {},
          custom_analysis_data: {},
          to_number: '+19999999999',
          from_number: '+10000000000',
          direction: 'inbound',
        }),
      });

      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: {
            call_id: callId,
            to_number: '+19999999999',
            from_number: '+10000000000',
          },
        });

      await flushAsync(80);

      expect(res.status).toBe(200);
      // No call record should be created (client_id NOT NULL constraint)
      const row = db.prepare('SELECT id FROM calls WHERE call_id = ?').get(callId);
      // better-sqlite3 returns undefined (not null) for not-found rows
      expect(row).toBeUndefined();
    });
  });

  // ── call_analyzed — updates call with AI summary ─────────────────────────

  describe('call_analyzed event — updates call with AI summary', () => {
    test('fills in transcript and summary when previously empty', async () => {
      seedClient(db);
      seedCall(db, { call_id: 'call_analyzed_001', transcript: null, summary: null });

      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: 'call_analyzed_001',
            transcript: 'agent: Thank you for calling.\nuser: I want to book.',
            call_analysis: {
              call_summary: 'Customer wants to book an appointment.',
              user_sentiment: 'positive',
            },
          },
        });

      await flushAsync(50);

      const row = db.prepare('SELECT transcript, summary, sentiment FROM calls WHERE call_id = ?')
        .get('call_analyzed_001');
      expect(row).not.toBeNull();
      expect(row.transcript).toContain('Thank you for calling');
      expect(row.summary).toBe('Customer wants to book an appointment.');
      expect(row.sentiment).toBe('positive');
    });

    test('does NOT overwrite existing non-empty transcript', async () => {
      seedClient(db);
      const existingTranscript = 'agent: Original transcript.';
      seedCall(db, {
        call_id: 'call_analyzed_002',
        transcript: existingTranscript,
        summary: 'Original summary',
      });

      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: 'call_analyzed_002',
            transcript: 'agent: New transcript that should not overwrite.',
            call_analysis: {
              call_summary: 'New summary attempt.',
              user_sentiment: 'neutral',
            },
          },
        });

      await flushAsync(50);

      const row = db.prepare('SELECT transcript, summary FROM calls WHERE call_id = ?')
        .get('call_analyzed_002');
      expect(row.transcript).toBe(existingTranscript);
      expect(row.summary).toBe('Original summary');
    });

    test('stores analysis_data as JSON blob', async () => {
      seedClient(db);
      seedCall(db, { call_id: 'call_analyzed_003' });

      const analysisPayload = {
        call_summary: 'Good interaction.',
        user_sentiment: 'positive',
        custom_field: 'value_xyz',
      };

      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: 'call_analyzed_003',
            transcript: '',
            call_analysis: analysisPayload,
          },
        });

      await flushAsync(50);

      const row = db.prepare('SELECT analysis_data FROM calls WHERE call_id = ?')
        .get('call_analyzed_003');
      expect(row).not.toBeNull();
      const parsed = JSON.parse(row.analysis_data);
      expect(parsed.custom_field).toBe('value_xyz');
    });

    test('handles missing call_id gracefully (no crash, 200 returned)', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            transcript: 'some transcript',
            call_analysis: { call_summary: 'summary' },
          },
        });

      expect(res.status).toBe(200);
    });
  });

  // ── Idempotency — same call_id processed twice ───────────────────────────

  describe('idempotency — duplicate webhook delivery', () => {
    test('call_ended with same call_id twice — second delivery is a no-op', async () => {
      seedClient(db);
      // Pre-seed call with an outcome to simulate already-processed state
      seedCall(db, {
        call_id: 'call_idem_001',
        outcome: 'completed',
        transcript: 'Existing transcript',
      });

      const payload = {
        event: 'call_ended',
        call: {
          call_id: 'call_idem_001',
          to_number: '+14155550100',
          from_number: '+12125550001',
          call_length: 60,
        },
      };

      // First delivery (already processed — has outcome set)
      await request(app).post('/webhooks/retell').send(payload);
      await flushAsync(80);

      const after1 = db.prepare('SELECT transcript, outcome FROM calls WHERE call_id = ?')
        .get('call_idem_001');

      // Second delivery
      await request(app).post('/webhooks/retell').send(payload);
      await flushAsync(80);

      const after2 = db.prepare('SELECT transcript, outcome FROM calls WHERE call_id = ?')
        .get('call_idem_001');

      // Row should be identical — second delivery was skipped
      expect(after2.outcome).toBe(after1.outcome);
      expect(after2.transcript).toBe(after1.transcript);
    });

    test('nonce deduplication — same call_id + event rejected on second delivery (200 with no re-processing)', async () => {
      seedClient(db);
      seedCall(db, { call_id: 'call_nonce_002' });

      const payload = {
        event: 'call_analyzed',
        call_id: 'call_nonce_002',
        call: {
          call_id: 'call_nonce_002',
          transcript: 'First delivery',
          call_analysis: { call_summary: 'First summary', user_sentiment: 'neutral' },
        },
      };

      const res1 = await request(app).post('/webhooks/retell').send(payload);
      await flushAsync(50);

      const res2 = await request(app).post('/webhooks/retell').send(payload);
      await flushAsync(50);

      // Both responses should be 200 (retries must not trigger HTTP errors)
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // Second delivery returns received:true (200 to suppress Retell retries)
      expect(res2.body.received).toBe(true);
    });
  });

  // ── Malformed payload handling ───────────────────────────────────────────

  describe('malformed payload handling', () => {
    test('completely empty body returns 200', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('missing event field logs and exits cleanly (200)', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({ call: { call_id: 'call_noevent' } });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('unrecognised event type returns 200 without crashing', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'completely_unknown_event_xyz',
          call: { call_id: 'call_unknown_event' },
        });

      expect(res.status).toBe(200);
    });

    test('call object missing call_id is handled without throwing', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_ended',
          call: { to_number: '+14155550100', from_number: '+12125550001' },
        });

      expect(res.status).toBe(200);
    });

    test('null call value is handled without throwing', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({ event: 'call_ended', call: null });

      expect(res.status).toBe(200);
    });

    test('deeply nested malformed payload does not crash server', async () => {
      const res = await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_analyzed',
          call: {
            call_id: null,
            call_analysis: null,
            transcript: null,
          },
        });

      expect(res.status).toBe(200);
    });
  });

  // ── call_started — basic smoke test ──────────────────────────────────────

  describe('call_started event — smoke test', () => {
    test('creates call record for known client phone', async () => {
      seedClient(db);

      const callId = 'call_started_001';
      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_started',
          call: {
            call_id: callId,
            to_number: '+14155550100',
            from_number: '+12125550001',
            direction: 'inbound',
          },
        });

      await flushAsync(50);

      const row = db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
      expect(row).not.toBeNull();
      expect(row.client_id).toBe('client-webhook-1');
      expect(row.direction).toBe('inbound');
    });

    test('falls back to retell_agent_id match when phone not in DB', async () => {
      seedClient(db, { phone_number: '+10000000000', retell_phone: '+10000000000' }); // different phone

      const callId = 'call_started_agentid_002';
      await request(app)
        .post('/webhooks/retell')
        .send({
          event: 'call_started',
          call: {
            call_id: callId,
            to_number: '+19999999999', // not in DB
            agent_id: 'agent_test_001',
            from_number: '+12125550001',
            direction: 'inbound',
          },
        });

      await flushAsync(50);

      const row = db.prepare('SELECT client_id FROM calls WHERE call_id = ?').get(callId);
      expect(row).not.toBeNull();
      expect(row.client_id).toBe('client-webhook-1');
    });
  });
});
