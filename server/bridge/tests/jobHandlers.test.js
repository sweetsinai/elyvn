/**
 * Tests for utils/jobHandlers.js — the createJobHandlers factory,
 * and each individual handler in jobs/handlers/*.js
 */

// ─── Mocks (must come before any require) ────────────────────────────────────

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../utils/dbHelpers', () => ({
  isLeadComplete: jest.fn((lead) => lead && ['booked', 'completed'].includes(lead.stage)),
}));

jest.mock('../config/timing', () => ({
  SMS_MAX_LENGTH: 1600,
  RETELL_CALL_TIMEOUT_MS: 15000,
}));

// Shared mutable breaker instance that tests can control
const mockBreakerCall = jest.fn();

jest.mock('../utils/resilience', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    call: (...args) => mockBreakerCall(...args),
  })),
}));

jest.mock('../utils/AppError', () => ({
  AppError: class AppError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

jest.mock('../utils/mailer', () => ({
  getTransporter: jest.fn(),
}));

jest.mock('../utils/config', () => ({
  outreach: {
    bookingLink: 'https://cal.com/test',
    senderName: 'Test Sender',
  },
  ai: { model: 'claude-3-5-haiku-latest' },
}));

jest.mock('../utils/sms', () => ({
  sendSMS: jest.fn(),
}));

jest.mock('../utils/metrics', () => ({
  recordMetric: jest.fn(),
}));

jest.mock('../utils/jobQueue', () => ({
  enqueueJob: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/optOut', () => ({
  recordOptOut: jest.fn(),
  isOptedOut: jest.fn().mockResolvedValue(false),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

const { createJobHandlers } = require('../utils/jobHandlers');
const { followupSms, appointmentReminder } = require('../jobs/handlers/appointmentReminder');
const { speedToLeadSms, speedToLeadCallback } = require('../jobs/handlers/speedToLead');
const { googleReviewRequest } = require('../jobs/handlers/reviewRequest');
const { isLeadComplete } = require('../utils/dbHelpers');
const { CircuitBreaker } = require('../utils/resilience');
const { enqueueJob } = require('../utils/jobQueue');
const { sendSMS: mockedSendSMS } = require('../utils/sms');
const { logger } = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(overrides = {}) {
  return {
    query: jest.fn(async (sql, params = [], mode = 'all') => {
      for (const [pattern, value] of Object.entries(overrides)) {
        if (sql.includes(pattern)) {
          return typeof value === 'function' ? value(sql, params, mode) : value;
        }
      }
      if (mode === 'get') return undefined;
      if (mode === 'run') return { changes: 1 };
      return [];
    }),
  };
}

// ─── createJobHandlers factory ────────────────────────────────────────────────

describe('createJobHandlers', () => {
  it('returns an object with all expected job type keys', () => {
    const db = makeDb();
    const sendSMS = jest.fn();
    const captureException = jest.fn();
    const handlers = createJobHandlers(db, sendSMS, captureException);

    expect(handlers).toHaveProperty('speed_to_lead_sms');
    expect(handlers).toHaveProperty('speed_to_lead_callback');
    expect(handlers).toHaveProperty('followup_sms');
    expect(handlers).toHaveProperty('appointment_reminder');
    expect(handlers).toHaveProperty('google_review_request');
  });

  it('returns callable functions for each key', () => {
    const db = makeDb();
    const handlers = createJobHandlers(db, jest.fn(), jest.fn());
    for (const key of Object.keys(handlers)) {
      expect(typeof handlers[key]).toBe('function');
    }
  });
});

// ─── followupSms ─────────────────────────────────────────────────────────────

describe('followupSms', () => {
  let db;
  let sendSMS;

  beforeEach(() => {
    jest.clearAllMocks();
    sendSMS = jest.fn().mockResolvedValue({ success: true });
    isLeadComplete.mockImplementation((lead) => lead && ['booked', 'completed'].includes(lead.stage));
  });

  it('sends SMS when lead is not complete and no recent duplicate', async () => {
    db = makeDb({
      'SELECT stage FROM leads': { stage: 'warm' },
      'SELECT id FROM messages': undefined, // no recent SMS
    });

    await followupSms(db, sendSMS, {
      leadId: 'lead1',
      phone: '+12125551234',
      message: 'Hello there!',
      from: '+10005550000',
      clientId: 'client1',
    });

    expect(sendSMS).toHaveBeenCalledWith('+12125551234', 'Hello there!', '+10005550000', db, 'client1');
  });

  it('skips when lead is already booked', async () => {
    db = makeDb({
      'SELECT stage FROM leads': { stage: 'booked' },
    });

    await followupSms(db, sendSMS, { leadId: 'lead1', phone: '+12125551234', message: 'Hi' });

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already booked'));
  });

  it('skips when lead is completed', async () => {
    db = makeDb({
      'SELECT stage FROM leads': { stage: 'completed' },
    });

    await followupSms(db, sendSMS, { leadId: 'lead1', phone: '+12125551234', message: 'Hi' });

    expect(sendSMS).not.toHaveBeenCalled();
  });

  it('skips when there is a recent duplicate SMS', async () => {
    db = makeDb({
      'SELECT stage FROM leads': { stage: 'warm' },
      'SELECT id FROM messages': { id: 'msg1' }, // recent SMS found
    });

    await followupSms(db, sendSMS, { leadId: 'lead1', phone: '+12125551234', message: 'Hi' });

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Skipping duplicate'));
  });

  it('sends SMS when no leadId is provided', async () => {
    db = makeDb({
      'SELECT id FROM messages': undefined,
    });

    await followupSms(db, sendSMS, {
      phone: '+12125551234',
      message: 'No lead ID',
      from: '+10005550000',
      clientId: 'client1',
    });

    expect(sendSMS).toHaveBeenCalled();
  });

  it('truncates message longer than SMS_MAX_LENGTH (1600 chars)', async () => {
    db = makeDb({ 'SELECT id FROM messages': undefined });
    const longMsg = 'A'.repeat(2000);

    await followupSms(db, sendSMS, { phone: '+12125551234', message: longMsg, from: '+1', clientId: 'c1' });

    expect(sendSMS).toHaveBeenCalledWith('+12125551234', 'A'.repeat(1600), '+1', db, 'c1');
  });

  it('uses payload.body as fallback when payload.message is absent', async () => {
    db = makeDb({ 'SELECT id FROM messages': undefined });

    await followupSms(db, sendSMS, { phone: '+12125551234', body: 'Body field', from: '+1', clientId: 'c1' });

    expect(sendSMS).toHaveBeenCalledWith('+12125551234', 'Body field', '+1', db, 'c1');
  });

  it('uses payload.to as phone fallback', async () => {
    db = makeDb({ 'SELECT id FROM messages': undefined });

    await followupSms(db, sendSMS, { to: '+15555550001', message: 'Hi', from: '+1', clientId: 'c1' });

    expect(sendSMS).toHaveBeenCalledWith('+15555550001', 'Hi', '+1', db, 'c1');
  });

  it('throws and logs on sendSMS error', async () => {
    db = makeDb({ 'SELECT id FROM messages': undefined });
    sendSMS.mockRejectedValue(new Error('Twilio 500'));

    await expect(
      followupSms(db, sendSMS, { phone: '+12125551234', message: 'Hi', from: '+1', clientId: 'c1' })
    ).rejects.toThrow('Twilio 500');

    expect(logger.error).toHaveBeenCalledWith(
      '[jobHandlers] followupSms error:',
      expect.objectContaining({ error: 'Twilio 500' })
    );
  });
});

// ─── appointmentReminder ──────────────────────────────────────────────────────

describe('appointmentReminder', () => {
  let db;
  let sendSMS;

  beforeEach(() => {
    jest.clearAllMocks();
    sendSMS = jest.fn().mockResolvedValue({ success: true });
  });

  it('sends reminder for active appointment', async () => {
    db = makeDb({
      'SELECT status FROM appointments': { status: 'confirmed' },
    });

    await appointmentReminder(db, sendSMS, {
      appointmentId: 'appt1',
      phone: '+12125551234',
      message: 'Reminder: your appointment is tomorrow',
      from: '+10005550000',
      clientId: 'client1',
    });

    expect(sendSMS).toHaveBeenCalledWith(
      '+12125551234',
      'Reminder: your appointment is tomorrow',
      '+10005550000',
      db,
      'client1'
    );
  });

  it('skips when appointment is cancelled', async () => {
    db = makeDb({
      'SELECT status FROM appointments': { status: 'cancelled' },
    });

    await appointmentReminder(db, sendSMS, {
      appointmentId: 'appt1',
      phone: '+12125551234',
      message: 'Reminder',
    });

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('sends when no appointmentId provided (no DB check)', async () => {
    db = makeDb();

    await appointmentReminder(db, sendSMS, {
      phone: '+12125551234',
      message: 'Hi',
      from: '+1',
      clientId: 'c1',
    });

    expect(sendSMS).toHaveBeenCalled();
  });

  it('truncates message to 1600 chars', async () => {
    db = makeDb({ 'SELECT status FROM appointments': { status: 'confirmed' } });
    const longMsg = 'B'.repeat(2000);

    await appointmentReminder(db, sendSMS, {
      appointmentId: 'appt1',
      phone: '+12125551234',
      message: longMsg,
      from: '+1',
      clientId: 'c1',
    });

    expect(sendSMS).toHaveBeenCalledWith('+12125551234', 'B'.repeat(1600), '+1', db, 'c1');
  });

  it('throws and logs on sendSMS error', async () => {
    db = makeDb({ 'SELECT status FROM appointments': { status: 'active' } });
    sendSMS.mockRejectedValue(new Error('SMS failed'));

    await expect(
      appointmentReminder(db, sendSMS, {
        appointmentId: 'appt1',
        phone: '+12125551234',
        message: 'Hi',
      })
    ).rejects.toThrow('SMS failed');

    expect(logger.error).toHaveBeenCalledWith(
      '[jobHandlers] appointmentReminder error:',
      expect.objectContaining({ error: 'SMS failed' })
    );
  });
});

// ─── speedToLeadSms ───────────────────────────────────────────────────────────

describe('speedToLeadSms', () => {
  let db;
  let sendSMS;

  beforeEach(() => {
    jest.clearAllMocks();
    sendSMS = jest.fn().mockResolvedValue({ success: true });
    isLeadComplete.mockImplementation((lead) => lead && ['booked', 'completed'].includes(lead.stage));
  });

  it('sends SMS to new lead with no recent duplicate', async () => {
    db = makeDb({
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM messages': undefined,
    });

    await speedToLeadSms(db, sendSMS, {
      leadId: 'lead1',
      phone: '+12125551234',
      message: 'Speed to lead!',
      from: '+10005550000',
      clientId: 'client1',
    });

    expect(sendSMS).toHaveBeenCalledWith('+12125551234', 'Speed to lead!', '+10005550000', db, 'client1');
  });

  it('skips when lead is already booked', async () => {
    db = makeDb({ 'SELECT stage FROM leads': { stage: 'booked' } });

    await speedToLeadSms(db, sendSMS, { leadId: 'lead1', phone: '+12125551234', message: 'Hi' });

    expect(sendSMS).not.toHaveBeenCalled();
  });

  it('skips when there is a recent duplicate outbound SMS', async () => {
    db = makeDb({
      'SELECT stage FROM leads': { stage: 'warm' },
      'SELECT id FROM messages': { id: 'msg1' },
    });

    await speedToLeadSms(db, sendSMS, { leadId: 'lead1', phone: '+12125551234', message: 'Hi' });

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Skipping duplicate'));
  });

  it('truncates message to SMS_MAX_LENGTH', async () => {
    db = makeDb({
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM messages': undefined,
    });

    await speedToLeadSms(db, sendSMS, {
      phone: '+12125551234',
      message: 'X'.repeat(2000),
      from: '+1',
      clientId: 'c1',
    });

    expect(sendSMS).toHaveBeenCalledWith('+12125551234', 'X'.repeat(1600), '+1', db, 'c1');
  });

  it('sends when no leadId is given', async () => {
    db = makeDb({ 'SELECT id FROM messages': undefined });

    await speedToLeadSms(db, sendSMS, {
      phone: '+12125551234',
      message: 'Hi!',
      from: '+1',
      clientId: 'c1',
    });

    expect(sendSMS).toHaveBeenCalled();
  });
});

// ─── speedToLeadCallback ──────────────────────────────────────────────────────

describe('speedToLeadCallback', () => {
  let db;
  let sendSMS;
  let captureException;

  const baseClient = {
    id: 'client1',
    business_name: 'Test Biz',
    is_active: 1,
    retell_agent_id: 'agent1',
    retell_phone: '+10005550001',
    telnyx_phone: '+10005550002',
    phone_number: '+10005550001',
    calcom_booking_link: 'https://cal.com/test',
    transfer_phone: '',
    owner_phone: '+15005550003',
  };

  const basePayload = {
    leadId: 'lead1',
    clientId: 'client1',
    phone: '+12125551234',
    name: 'John Doe',
    reason: 'speed_callback',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sendSMS = jest.fn().mockResolvedValue({ success: true });
    captureException = jest.fn();
    isLeadComplete.mockImplementation((lead) => lead && ['booked', 'completed'].includes(lead.stage));
    process.env.RETELL_API_KEY = 'test-retell-key';
    // Default: successful Retell API call
    mockBreakerCall.mockResolvedValue({
      ok: true,
      fallback: false,
      json: jest.fn().mockResolvedValue({ call_id: 'default-call' }),
    });
  });

  afterEach(() => {
    delete process.env.RETELL_API_KEY;
  });

  it('skips when client not found', async () => {
    db = makeDb({ 'SELECT * FROM clients': undefined });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('skips when lead is already booked', async () => {
    db = makeDb({
      'SELECT * FROM clients': baseClient,
      'SELECT stage FROM leads': { stage: 'booked' },
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(sendSMS).not.toHaveBeenCalled();
  });

  it('skips when AI is paused (is_active = 0)', async () => {
    db = makeDb({
      'SELECT * FROM clients': { ...baseClient, is_active: 0 },
      'SELECT stage FROM leads': { stage: 'new' },
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('AI paused'));
  });

  it('skips when there is a recent duplicate call', async () => {
    db = makeDb({
      'SELECT * FROM clients': baseClient,
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM calls': { id: 'call1' },
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Skipping duplicate call'));
  });

  it('falls back to SMS when no RETELL_API_KEY', async () => {
    delete process.env.RETELL_API_KEY;
    db = makeDb({
      'SELECT * FROM clients': baseClient,
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM calls': undefined,
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No RETELL_API_KEY'));
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it('falls back to SMS when agentId or fromPhone missing', async () => {
    db = makeDb({
      'SELECT * FROM clients': { ...baseClient, retell_agent_id: null, retell_phone: null },
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM calls': undefined,
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(sendSMS).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing agent_id'));
  });

  it('makes Retell call successfully via fetch', async () => {
    const mockResp = {
      ok: true,
      fallback: false,
      json: jest.fn().mockResolvedValue({ call_id: 'retell-call-123' }),
    };
    mockBreakerCall.mockResolvedValue(mockResp);

    db = makeDb({
      'SELECT * FROM clients': baseClient,
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM calls': undefined,
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Retell outbound call created'));
  });

  it('falls back to SMS when Retell circuit is open (fallback: true)', async () => {
    mockBreakerCall.mockResolvedValue({ ok: false, fallback: true });

    db = makeDb({
      'SELECT * FROM clients': baseClient,
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM calls': undefined,
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(sendSMS).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('circuit open'));
  });

  it('falls back to SMS and calls captureException on Retell error', async () => {
    mockBreakerCall.mockRejectedValue(new Error('Network error'));

    db = makeDb({
      'SELECT * FROM clients': baseClient,
      'SELECT stage FROM leads': { stage: 'new' },
      'SELECT id FROM calls': undefined,
    });

    await speedToLeadCallback(db, sendSMS, captureException, basePayload);

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'speed_to_lead_callback' })
    );
    expect(sendSMS).toHaveBeenCalled();
  });
});

// ─── googleReviewRequest ──────────────────────────────────────────────────────

describe('googleReviewRequest', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSendSMS.mockResolvedValue({ success: true });
  });

  const basePayload = {
    phone: '+12125551234',
    clientId: 'client1',
    leadId: 'lead1',
    appointmentId: 'appt1',
    businessName: 'Awesome Co',
    googleReviewLink: 'https://g.page/review',
    from: '+10005550001',
  };

  it('sends review request SMS', async () => {
    db = makeDb({
      'SELECT status FROM appointments': { status: 'completed' },
      'SELECT 1 FROM sms_opt_outs': undefined,
      'SELECT id FROM messages': undefined,
    });

    await googleReviewRequest(basePayload, 'job1', db);

    expect(mockedSendSMS).toHaveBeenCalledWith(
      '+12125551234',
      expect.stringContaining('https://g.page/review'),
      '+10005550001',
      db,
      'client1'
    );
  });

  it('skips when phone is missing', async () => {
    db = makeDb();
    const payload = { ...basePayload, phone: undefined };

    await googleReviewRequest(payload, 'job1', db);

    expect(mockedSendSMS).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing required fields'));
  });

  it('skips when googleReviewLink is missing', async () => {
    db = makeDb();

    await googleReviewRequest({ ...basePayload, googleReviewLink: undefined }, 'job1', db);

    expect(mockedSendSMS).not.toHaveBeenCalled();
  });

  it('skips when appointment is cancelled', async () => {
    db = makeDb({
      'SELECT status FROM appointments': { status: 'cancelled' },
    });

    await googleReviewRequest(basePayload, 'job1', db);

    expect(mockedSendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('was cancelled'));
  });

  it('skips when lead is opted out', async () => {
    db = makeDb({
      'SELECT status FROM appointments': { status: 'completed' },
      'SELECT 1 FROM sms_opt_outs': { 1: 1 },
    });

    await googleReviewRequest(basePayload, 'job1', db);

    expect(mockedSendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('opted out'));
  });

  it('skips when a review request was sent in the past 30 days', async () => {
    db = makeDb({
      'SELECT status FROM appointments': { status: 'completed' },
      'SELECT 1 FROM sms_opt_outs': undefined,
      'SELECT id FROM messages': { id: 'msg1' },
    });

    await googleReviewRequest(basePayload, 'job1', db);

    expect(mockedSendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already sent'));
  });

  it('logs warning but does not throw when sendSMS returns failure', async () => {
    mockedSendSMS.mockResolvedValue({ success: false, error: 'No carrier' });
    db = makeDb({
      'SELECT status FROM appointments': { status: 'completed' },
      'SELECT 1 FROM sms_opt_outs': undefined,
      'SELECT id FROM messages': undefined,
    });

    await expect(googleReviewRequest(basePayload, 'job1', db)).resolves.not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SMS send failed'));
  });

  it('throws and logs on unexpected error', async () => {
    mockedSendSMS.mockRejectedValue(new Error('Boom'));
    db = makeDb({
      'SELECT status FROM appointments': { status: 'completed' },
      'SELECT 1 FROM sms_opt_outs': undefined,
      'SELECT id FROM messages': undefined,
    });

    await expect(googleReviewRequest(basePayload, 'job1', db)).rejects.toThrow('Boom');
    expect(logger.error).toHaveBeenCalledWith(
      '[reviewRequest] Error:',
      expect.objectContaining({ error: 'Boom', jobId: 'job1' })
    );
  });

  it('records metric after successful send', async () => {
    const { recordMetric } = require('../utils/metrics');
    db = makeDb({
      'SELECT status FROM appointments': { status: 'completed' },
      'SELECT 1 FROM sms_opt_outs': undefined,
      'SELECT id FROM messages': undefined,
    });

    await googleReviewRequest(basePayload, 'job1', db);

    expect(recordMetric).toHaveBeenCalledWith('review_requests_sent', 1);
  });

  it('works without an appointmentId (no appointment check)', async () => {
    db = makeDb({
      'SELECT 1 FROM sms_opt_outs': undefined,
      'SELECT id FROM messages': undefined,
    });

    await googleReviewRequest({ ...basePayload, appointmentId: undefined }, 'job1', db);

    expect(mockedSendSMS).toHaveBeenCalled();
  });
});
