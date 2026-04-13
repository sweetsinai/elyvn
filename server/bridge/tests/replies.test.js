'use strict';

const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');

// ─── Mocks (must come before any require of route files) ─────────────────────

jest.mock('../utils/config', () => ({
  ai: { model: 'claude-3-5-sonnet-20241022' },
  outreach: {
    senderName: 'Sohan',
    bookingLink: 'https://cal.com/elyvn/demo',
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock Anthropic SDK
const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  }));
});

// Mock mailer
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-msg-id' });
jest.mock('../utils/mailer', () => ({
  getTransporter: jest.fn(() => ({ sendMail: mockSendMail })),
}));

// Mock eventStore
jest.mock('../utils/eventStore', () => ({
  appendEvent: jest.fn(),
  Events: {
    ReplyReceived: 'ReplyReceived',
    LeadStageChanged: 'LeadStageChanged',
  },
}));

// Mock SMS
jest.mock('../utils/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue({}),
}));

// Mock Telegram
jest.mock('../utils/telegram', () => ({
  sendTelegramNotification: jest.fn().mockResolvedValue({}),
}));

// Mock jobQueue
jest.mock('../utils/jobQueue', () => ({
  enqueueJob: jest.fn(),
}));

// Mock autoClassify
jest.mock('../utils/autoClassify', () => ({
  autoClassifyReplies: jest.fn().mockResolvedValue({
    classified: 5,
    results: [],
    message: 'Classified 5 replies',
  }),
}));

// ─── Route under test ────────────────────────────────────────────────────────

const repliesRouter = require('../routes/replies');

// ─── Test helpers ─────────────────────────────────────────────────────────────

const VALID_API_KEY = 'test-replies-api-key';

let testClientId;
let testEmailId;
let testProspectId;

beforeAll(() => {
  testClientId = randomUUID();
  testEmailId = randomUUID();
  testProspectId = randomUUID();
});

function buildApp(db, { isAdmin = true, clientId } = {}) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'API key required' });
    if (key !== VALID_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
    req.isAdmin = isAdmin;
    req.clientId = clientId || testClientId;
    next();
  });

  app.use('/', repliesRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.message, code: err.code });
  });

  app.locals.db = db;
  return app;
}

function makeClaudeResponse(json) {
  return {
    content: [{ text: JSON.stringify(json) }],
  };
}

// ─── Mock DB factory ─────────────────────────────────────────────────────────

function createMockDb({ email = null, prospect = null, replies = [], client = null } = {}) {
  return {
    query: jest.fn((sql, params = [], mode = 'all') => {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (mode === 'all' && s.includes('FROM emails_sent') && s.includes('reply_text IS NOT NULL')) {
        return Promise.resolve(replies);
      }

      if (mode === 'get' && s.includes('FROM emails_sent WHERE id')) {
        return Promise.resolve(email);
      }

      if (mode === 'get' && s.includes('FROM prospects WHERE id')) {
        return Promise.resolve(prospect);
      }

      if (mode === 'get' && s.includes('FROM clients')) {
        return Promise.resolve(client);
      }

      if (mode === 'get' && s.includes('FROM leads WHERE')) {
        return Promise.resolve(null); // no existing lead
      }

      if (mode === 'run') {
        return Promise.resolve({ changes: 1 });
      }

      return Promise.resolve(null);
    }),
  };
}

// ─── GET /replies ─────────────────────────────────────────────────────────────

describe('GET /replies', () => {
  test('returns 401 without API key', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app).get('/replies');
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid API key', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app)
      .get('/replies')
      .set('x-api-key', 'bad-key');
    expect(res.status).toBe(401);
  });

  test('returns empty replies array when no replies exist', async () => {
    const app = buildApp(createMockDb({ replies: [] }));
    const res = await request(app)
      .get('/replies')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.replies).toEqual([]);
  });

  test('returns replies list for admin', async () => {
    const fakeReply = {
      id: testEmailId,
      reply_text: 'Yes, interested!',
      business_name: 'ACME Corp',
      campaign_name: 'Test Campaign',
    };
    const app = buildApp(createMockDb({ replies: [fakeReply] }));
    const res = await request(app)
      .get('/replies')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.replies).toHaveLength(1);
    expect(res.body.replies[0].reply_text).toBe('Yes, interested!');
  });

  test('non-admin gets filtered replies (client filter applied)', async () => {
    const fakeReply = { id: testEmailId, reply_text: 'Sure', business_name: 'Biz', campaign_name: 'C' };
    const db = createMockDb({ replies: [fakeReply] });
    const app = buildApp(db, { isAdmin: false, clientId: testClientId });
    const res = await request(app)
      .get('/replies')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    // The query call should include clientId in params for non-admin
    const queryCalls = db.query.mock.calls;
    const repliesCall = queryCalls.find(([sql]) => sql.includes('reply_text IS NOT NULL'));
    expect(repliesCall).toBeDefined();
    // Non-admin: params array includes clientId
    expect(repliesCall[1]).toContain(testClientId);
  });

  test('admin gets all replies (no client filter)', async () => {
    const fakeReply = { id: testEmailId, reply_text: 'Hi', business_name: 'Biz', campaign_name: 'C' };
    const db = createMockDb({ replies: [fakeReply] });
    const app = buildApp(db, { isAdmin: true });
    const res = await request(app)
      .get('/replies')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    const queryCalls = db.query.mock.calls;
    const repliesCall = queryCalls.find(([sql]) => sql.includes('reply_text IS NOT NULL'));
    expect(repliesCall[1]).toEqual([]); // no params for admin
  });

  test('returns 500 on db error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('DB down')) };
    const app = buildApp(db);
    const res = await request(app)
      .get('/replies')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch replies');
  });
});

// ─── POST /replies/:emailId/classify ─────────────────────────────────────────

describe('POST /replies/:emailId/classify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'ok' });
  });

  const baseEmail = () => ({
    id: testEmailId,
    prospect_id: testProspectId,
    reply_text: 'I am interested in your service!',
    reply_classification: null,
    subject: 'Re: Grow your business',
    body: 'Hey there, we help businesses...',
    to_email: 'prospect@example.com',
    from_email: 'sender@elyvn.com',
    clicked_at: null,
    client_id: testClientId,
  });

  const baseProspect = () => ({
    id: testProspectId,
    business_name: 'ACME Corp',
    phone: '+14155550000',
    status: 'active',
    email: 'prospect@example.com',
  });

  test('returns 401 without API key', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app).post(`/replies/${testEmailId}/classify`);
    expect(res.status).toBe(401);
  });

  test('returns 422 with invalid emailId (non-UUID)', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app)
      .post('/replies/not-a-valid-uuid/classify')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(422);
  });

  test('returns 404 when email not found', async () => {
    const app = buildApp(createMockDb({ email: null }));
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Email or reply not found');
  });

  test('returns 404 when email has no reply_text', async () => {
    const emailNoReply = { ...baseEmail(), reply_text: null };
    const app = buildApp(createMockDb({ email: emailNoReply }));
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(404);
  });

  test('returns skipped=true when already classified (idempotency)', async () => {
    const alreadyClassified = { ...baseEmail(), reply_classification: 'INTERESTED' };
    const app = buildApp(createMockDb({ email: alreadyClassified }));
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toBe('already_classified');
    expect(res.body.classification).toBe('INTERESTED');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  test('classifies INTERESTED and triggers full conversion sequence', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'INTERESTED', confidence: 0.95, suggested_response: 'Great!' })
    );

    const { sendTelegramNotification } = require('../utils/telegram');
    const { enqueueJob } = require('../utils/jobQueue');
    const db = createMockDb({
      email: baseEmail(),
      prospect: baseProspect(),
      client: { id: testClientId, name: 'Test Client', is_active: 1 },
    });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe('INTERESTED');
    // Auto-reply email sent
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'prospect@example.com' })
    );
    // Telegram notification fired
    expect(sendTelegramNotification).toHaveBeenCalled();
    // Follow-up job queued
    expect(enqueueJob).toHaveBeenCalledWith(
      db,
      'interested_followup_email',
      expect.objectContaining({ to_email: 'prospect@example.com' }),
      expect.any(String)
    );
  });

  test('classifies QUESTION and sends helpful auto-reply with booking link', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'QUESTION', confidence: 0.85, suggested_response: 'We cover all areas.' })
    );

    const db = createMockDb({ email: baseEmail(), prospect: baseProspect() });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe('QUESTION');
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'prospect@example.com' })
    );
    // suggested_response should include booking link
    expect(res.body.suggested_response).toContain('https://cal.com/elyvn/demo');
  });

  test('classifies UNSUBSCRIBE and sends removal confirmation email', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'UNSUBSCRIBE', confidence: 0.99, suggested_response: '' })
    );

    const db = createMockDb({ email: baseEmail(), prospect: baseProspect() });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe('UNSUBSCRIBE');
    expect(mockSendMail).toHaveBeenCalled();
    expect(res.body.suggested_response).toContain('removed from our list');
  });

  test('classifies NOT_INTERESTED and updates prospect status', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'NOT_INTERESTED', confidence: 0.9, suggested_response: '' })
    );

    const db = createMockDb({ email: baseEmail(), prospect: baseProspect() });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe('NOT_INTERESTED');
    // Prospect status should be updated
    const updateCall = db.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE prospects SET status')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe('not_interested');
  });

  test('returns needs_review when confidence is below threshold', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'INTERESTED', confidence: 0.4, suggested_response: '' })
    );

    const db = createMockDb({ email: baseEmail(), prospect: baseProspect() });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.needs_review).toBe(true);
    expect(res.body.classification).toBe('INTERESTED');
    // Should NOT send auto-reply emails for low-confidence
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('falls back to text parsing when Claude returns non-JSON', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ text: 'Based on the reply, this is INTERESTED in the service.' }],
    });

    const db = createMockDb({ email: baseEmail(), prospect: baseProspect() });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    // Should resolve but with low confidence (0.5) → needs_review
    expect(res.status).toBe(200);
    expect(res.body.needs_review).toBe(true);
  });

  test('reply_attributed_to_click is set when clicked_at is recent', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'QUESTION', confidence: 0.8, suggested_response: 'Answer here.' })
    );

    const recentClick = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1h ago
    const emailWithClick = { ...baseEmail(), clicked_at: recentClick };
    const db = createMockDb({ email: emailWithClick, prospect: baseProspect() });
    const app = buildApp(db);
    await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    const updateClassificationCall = db.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE emails_sent SET reply_classification')
    );
    expect(updateClassificationCall).toBeDefined();
    // reply_attributed_to_click should be 1
    expect(updateClassificationCall[1][1]).toBe(1);
  });

  test('reply_attributed_to_click is 0 when clicked_at is older than 7 days', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'QUESTION', confidence: 0.8, suggested_response: 'Old click.' })
    );

    const oldClick = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    const emailOldClick = { ...baseEmail(), clicked_at: oldClick };
    const db = createMockDb({ email: emailOldClick, prospect: baseProspect() });
    const app = buildApp(db);
    await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    const updateClassificationCall = db.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE emails_sent SET reply_classification')
    );
    expect(updateClassificationCall).toBeDefined();
    expect(updateClassificationCall[1][1]).toBe(0);
  });

  test('INTERESTED prospect with phone triggers SMS send', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'INTERESTED', confidence: 0.95, suggested_response: '' })
    );

    const { sendSMS } = require('../utils/sms');
    const db = createMockDb({
      email: baseEmail(),
      prospect: baseProspect(), // has phone
      client: { id: testClientId, name: 'Test', is_active: 1 },
    });
    const app = buildApp(db);
    await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(sendSMS).toHaveBeenCalledWith('+14155550000', expect.any(String), null, db, null);
  });

  test('INTERESTED prospect without phone skips SMS', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'INTERESTED', confidence: 0.95, suggested_response: '' })
    );

    const { sendSMS } = require('../utils/sms');
    sendSMS.mockClear();
    const prospectNoPhone = { ...baseProspect(), phone: null };
    const db = createMockDb({
      email: baseEmail(),
      prospect: prospectNoPhone,
      client: { id: testClientId, name: 'Test', is_active: 1 },
    });
    const app = buildApp(db);
    await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(sendSMS).not.toHaveBeenCalled();
  });

  test('mailer failure does not crash the classify response', async () => {
    mockMessagesCreate.mockResolvedValue(
      makeClaudeResponse({ classification: 'INTERESTED', confidence: 0.9, suggested_response: '' })
    );
    mockSendMail.mockRejectedValueOnce(new Error('SMTP timeout'));

    const db = createMockDb({
      email: baseEmail(),
      prospect: baseProspect(),
      client: { id: testClientId, name: 'Test', is_active: 1 },
    });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe('INTERESTED');
  });

  test('Anthropic API error propagates as 500', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('Anthropic API error'));

    const db = createMockDb({ email: baseEmail(), prospect: baseProspect() });
    const app = buildApp(db);
    const res = await request(app)
      .post(`/replies/${testEmailId}/classify`)
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(500);
  });
});

// ─── POST /auto-classify ─────────────────────────────────────────────────────

describe('POST /auto-classify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 401 without API key', async () => {
    const app = buildApp(createMockDb());
    const res = await request(app).post('/auto-classify');
    expect(res.status).toBe(401);
  });

  test('returns 403 for non-admin callers', async () => {
    const app = buildApp(createMockDb(), { isAdmin: false });
    const res = await request(app)
      .post('/auto-classify')
      .set('x-api-key', VALID_API_KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin access required');
  });

  test('classifies all unclassified replies and returns summary', async () => {
    const { autoClassifyReplies } = require('../utils/autoClassify');
    autoClassifyReplies.mockResolvedValue({
      classified: 3,
      results: [{ emailId: testEmailId, classification: 'INTERESTED' }],
      message: 'Classified 3 replies',
    });

    const app = buildApp(createMockDb(), { isAdmin: true });
    const res = await request(app)
      .post('/auto-classify')
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.classified).toBe(3);
    expect(res.body.message).toBe('Classified 3 replies');
    expect(autoClassifyReplies).toHaveBeenCalledTimes(1);
  });

  test('returns 500 when autoClassifyReplies throws', async () => {
    const { autoClassifyReplies } = require('../utils/autoClassify');
    autoClassifyReplies.mockRejectedValue(new Error('AI quota exceeded'));

    const app = buildApp(createMockDb(), { isAdmin: true });
    const res = await request(app)
      .post('/auto-classify')
      .set('x-api-key', VALID_API_KEY);

    expect(res.status).toBe(500);
  });
});
