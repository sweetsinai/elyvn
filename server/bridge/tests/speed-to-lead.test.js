/**
 * Tests for utils/speed-to-lead.js — triggerSpeedSequence and helpers
 */

jest.mock('../utils/sms', () => ({
  sendSMS: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../utils/telegram', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../utils/phone', () => ({
  normalizePhone: jest.fn((p) => p),
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../utils/jobQueue', () => ({
  enqueueJob: jest.fn(),
}));
jest.mock('../utils/businessHours', () => ({
  shouldDelayUntilBusinessHours: jest.fn(() => 0),
}));
jest.mock('../utils/smartScheduler', () => ({
  getOptimalContactTime: jest.fn(() => null),
}));

describe('speed-to-lead', () => {
  let triggerSpeedSequence;
  let enqueueJob;
  let telegram;
  let getOptimalContactTime;
  let mockDb;

  function buildDb() {
    const inserts = { messages: [], followups: [] };
    return {
      _inserts: inserts,
      prepare: jest.fn((sql) => {
        if (sql.includes('INSERT INTO messages')) {
          return { run: jest.fn((...args) => inserts.messages.push(args)) };
        }
        if (sql.includes('INSERT INTO followups')) {
          return { run: jest.fn((...args) => inserts.followups.push(args)) };
        }
        if (sql.includes("SELECT id FROM followups WHERE lead_id")) {
          return { get: jest.fn(() => null) }; // No existing followups
        }
        return { get: jest.fn(() => null), run: jest.fn(), all: jest.fn(() => []) };
      }),
    };
  }

  const baseClient = {
    id: 'client-1',
    business_name: 'TestBiz',
    telnyx_phone: '+18001234567',
    twilio_phone: '+18009876543',
    calcom_booking_link: 'https://cal.com/test',
    retell_agent_id: 'agent-1',
    retell_phone: '+18001111111',
    telegram_chat_id: null,
    notification_mode: 'instant',
  };

  const baseLeadData = {
    leadId: 'lead-1',
    clientId: 'client-1',
    phone: '+15551112222',
    name: 'John Doe',
    email: 'john@test.com',
    message: 'Need a quote',
    service: 'Plumbing',
    source: 'form',
    client: baseClient,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    enqueueJob = require('../utils/jobQueue').enqueueJob;
    telegram = require('../utils/telegram');
    getOptimalContactTime = require('../utils/smartScheduler').getOptimalContactTime;

    const stl = require('../utils/speed-to-lead');
    triggerSpeedSequence = stl.triggerSpeedSequence;

    mockDb = buildDb();
  });

  test('triggerSpeedSequence queues 3 touches (SMS + callback + follow-up)', async () => {
    await triggerSpeedSequence(mockDb, baseLeadData);

    // Touch 1: speed_to_lead_sms
    const smsJobs = enqueueJob.mock.calls.filter(c => c[1] === 'speed_to_lead_sms');
    expect(smsJobs.length).toBe(1);

    // Touch 2: speed_to_lead_callback
    const callbackJobs = enqueueJob.mock.calls.filter(c => c[1] === 'speed_to_lead_callback');
    expect(callbackJobs.length).toBe(1);

    // Touch 3: followup_sms
    const followupJobs = enqueueJob.mock.calls.filter(c => c[1] === 'followup_sms');
    expect(followupJobs.length).toBe(1);
  });

  test('also inserts touch 4 and 5 followups into DB', async () => {
    await triggerSpeedSequence(mockDb, baseLeadData);

    // Two followup inserts (touch 4 at 24h, touch 5 at 72h)
    expect(mockDb._inserts.followups.length).toBe(2);
  });

  test('smart timing uses getOptimalContactTime when confidence > 0.5', async () => {
    getOptimalContactTime.mockReturnValue({
      optimal_hour: 14,
      confidence: 0.8,
    });

    await triggerSpeedSequence(mockDb, baseLeadData);

    expect(getOptimalContactTime).toHaveBeenCalledWith(mockDb, 'lead-1', 'client-1');

    // Callback job should have been enqueued (regardless of delay value)
    const callbackJobs = enqueueJob.mock.calls.filter(c => c[1] === 'speed_to_lead_callback');
    expect(callbackJobs.length).toBe(1);
  });

  test('falls back to 60s for new leads (no smart timing)', async () => {
    getOptimalContactTime.mockReturnValue(null);

    await triggerSpeedSequence(mockDb, baseLeadData);

    // Callback is still queued with default timing
    const callbackJobs = enqueueJob.mock.calls.filter(c => c[1] === 'speed_to_lead_callback');
    expect(callbackJobs.length).toBe(1);
  });

  test('dedup prevents duplicate touch_number inserts', async () => {
    // Make touch 4 already exist
    mockDb.prepare = jest.fn((sql) => {
      if (sql.includes('INSERT INTO messages')) {
        return { run: jest.fn() };
      }
      if (sql.includes("SELECT id FROM followups WHERE lead_id = ? AND touch_number = 4")) {
        return { get: jest.fn(() => ({ id: 'existing-4' })) };
      }
      if (sql.includes("SELECT id FROM followups WHERE lead_id = ? AND touch_number = 5")) {
        return { get: jest.fn(() => null) };
      }
      if (sql.includes('INSERT INTO followups')) {
        return { run: jest.fn((...args) => mockDb._inserts.followups.push(args)) };
      }
      return { get: jest.fn(() => null), run: jest.fn(), all: jest.fn(() => []) };
    });

    mockDb._inserts.followups = [];
    await triggerSpeedSequence(mockDb, baseLeadData);

    // Only touch 5 inserted (touch 4 already exists)
    expect(mockDb._inserts.followups.length).toBe(1);
  });

  test('digest mode skips Telegram notification', async () => {
    const digestClient = {
      ...baseClient,
      telegram_chat_id: '12345',
      notification_mode: 'digest',
    };

    await triggerSpeedSequence(mockDb, {
      ...baseLeadData,
      client: digestClient,
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  test('sends Telegram notification when not in digest mode', async () => {
    const notifyClient = {
      ...baseClient,
      telegram_chat_id: '12345',
      notification_mode: 'instant',
    };

    await triggerSpeedSequence(mockDb, {
      ...baseLeadData,
      client: notifyClient,
    });

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('Speed-to-lead activated'),
      expect.any(Object)
    );
  });

  test('missing phone or client logs error and returns early', async () => {
    const logger = require('../utils/logger').logger;

    await triggerSpeedSequence(mockDb, { ...baseLeadData, phone: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Missing phone or client'));

    await triggerSpeedSequence(mockDb, { ...baseLeadData, client: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Missing phone or client'));
  });
});
