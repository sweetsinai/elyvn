/**
 * Unit tests for jobs/handlers/appointmentReminder.js
 * Covers: followupSms and appointmentReminder handlers
 */

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../utils/dbHelpers', () => ({
  isLeadComplete: jest.fn(),
}));

const { followupSms, appointmentReminder } = require('../../../jobs/handlers/appointmentReminder');
const { logger } = require('../../../utils/logger');
const { isLeadComplete } = require('../../../utils/dbHelpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDb(overrides = {}) {
  const defaults = {
    leadRow: { stage: 'new' },
    recentSMS: null,
    apptRow: null,
  };
  const cfg = { ...defaults, ...overrides };

  return {
    query: jest.fn(async (sql, params, method) => {
      if (sql.includes('SELECT stage FROM leads')) return cfg.leadRow;
      if (sql.includes('SELECT id FROM messages'))  return cfg.recentSMS;
      if (sql.includes('SELECT status FROM appointments')) return cfg.apptRow;
      return null;
    }),
  };
}

// ---------------------------------------------------------------------------
// followupSms
// ---------------------------------------------------------------------------

describe('followupSms', () => {
  let sendSMS;

  beforeEach(() => {
    jest.clearAllMocks();
    sendSMS = jest.fn().mockResolvedValue({ success: true });
    isLeadComplete.mockReturnValue(false);
  });

  it('sends SMS on the happy path', async () => {
    const db = buildDb();
    const payload = {
      leadId: 'lead-1',
      phone: '+15551112222',
      from: '+18001234567',
      message: 'Hi there!',
      clientId: 'client-1',
    };

    await followupSms(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalledWith(
      '+15551112222',
      'Hi there!',
      '+18001234567',
      db,
      'client-1'
    );
  });

  it('skips when lead is already booked/completed', async () => {
    isLeadComplete.mockReturnValue(true);
    const db = buildDb({ leadRow: { stage: 'booked' } });
    const payload = { leadId: 'lead-1', phone: '+15551112222', message: 'Hi' };

    await followupSms(db, sendSMS, payload);

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping followup_sms')
    );
  });

  it('skips when a recent duplicate SMS exists', async () => {
    const db = buildDb({ recentSMS: { id: 'msg-99' } });
    const payload = { leadId: 'lead-1', phone: '+15551112222', message: 'Hi' };

    await followupSms(db, sendSMS, payload);

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate SMS')
    );
  });

  it('handles missing leadId (no lead query) and still sends', async () => {
    const db = buildDb();
    const payload = {
      phone: '+15551112222',
      from: '+18001234567',
      message: 'No lead id',
      clientId: 'client-1',
    };

    await followupSms(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalled();
    // isLeadComplete should NOT have been called since there's no leadId
    expect(isLeadComplete).not.toHaveBeenCalled();
  });

  it('uses payload.to as phone fallback when payload.phone is absent', async () => {
    const db = buildDb();
    const payload = {
      to: '+15559998888',
      from: '+18001234567',
      message: 'Using to field',
    };

    await followupSms(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalledWith(
      '+15559998888',
      expect.any(String),
      expect.any(String),
      expect.anything(),
      undefined
    );
  });

  it('uses payload.body as message fallback when payload.message is absent', async () => {
    const db = buildDb();
    const payload = { phone: '+15551112222', body: 'Body text', from: '+1' };

    await followupSms(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalledWith(
      '+15551112222',
      'Body text',
      '+1',
      db,
      undefined
    );
  });

  it('truncates message to 1600 characters', async () => {
    const db = buildDb();
    const longMsg = 'A'.repeat(2000);
    const payload = { phone: '+15551112222', message: longMsg, from: '+1' };

    await followupSms(db, sendSMS, payload);

    const sentMsg = sendSMS.mock.calls[0][1];
    expect(sentMsg.length).toBe(1600);
  });

  it('propagates sendSMS errors without silencing them', async () => {
    const db = buildDb();
    sendSMS.mockRejectedValue(new Error('Twilio down'));
    const payload = { phone: '+15551112222', message: 'Hi', from: '+1' };

    await expect(followupSms(db, sendSMS, payload)).rejects.toThrow('Twilio down');
  });

  it('propagates db.query errors without silencing them', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('DB gone')) };
    const payload = { leadId: 'lead-1', phone: '+15551112222', message: 'Hi', from: '+1' };

    await expect(followupSms(db, sendSMS, payload)).rejects.toThrow('DB gone');
  });
});

// ---------------------------------------------------------------------------
// appointmentReminder
// ---------------------------------------------------------------------------

describe('appointmentReminder', () => {
  let sendSMS;

  beforeEach(() => {
    jest.clearAllMocks();
    sendSMS = jest.fn().mockResolvedValue({ success: true });
  });

  it('sends reminder SMS on the happy path', async () => {
    const db = buildDb({ apptRow: { status: 'confirmed' } });
    const payload = {
      appointmentId: 'appt-1',
      phone: '+15551112222',
      from: '+18001234567',
      message: 'Your appt is tomorrow!',
      clientId: 'client-1',
    };

    await appointmentReminder(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalledWith(
      '+15551112222',
      'Your appt is tomorrow!',
      '+18001234567',
      db,
      'client-1'
    );
  });

  it('skips when appointment is cancelled', async () => {
    const db = buildDb({ apptRow: { status: 'cancelled' } });
    const payload = {
      appointmentId: 'appt-1',
      phone: '+15551112222',
      message: 'Reminder',
    };

    await appointmentReminder(db, sendSMS, payload);

    expect(sendSMS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping reminder')
    );
  });

  it('sends reminder when no appointment row is found (external booking)', async () => {
    // apptRow: null means the appointment wasn't found — we still send
    const db = buildDb({ apptRow: null });
    const payload = {
      appointmentId: 'appt-external',
      phone: '+15551112222',
      from: '+1',
      message: 'Reminder text',
    };

    await appointmentReminder(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalled();
  });

  it('sends when appointmentId is absent (no DB lookup performed)', async () => {
    const db = buildDb();
    const payload = {
      phone: '+15551112222',
      from: '+18001234567',
      message: 'Reminder',
      clientId: 'client-1',
    };

    await appointmentReminder(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalled();
    // query should NOT have been called at all
    expect(db.query).not.toHaveBeenCalled();
  });

  it('truncates message to 1600 characters', async () => {
    const db = buildDb();
    const longMsg = 'B'.repeat(2000);
    const payload = { phone: '+15551112222', message: longMsg, from: '+1' };

    await appointmentReminder(db, sendSMS, payload);

    const sentMsg = sendSMS.mock.calls[0][1];
    expect(sentMsg.length).toBe(1600);
  });

  it('propagates sendSMS failure without silencing it', async () => {
    const db = buildDb({ apptRow: { status: 'confirmed' } });
    sendSMS.mockRejectedValue(new Error('SMS service unavailable'));
    const payload = {
      appointmentId: 'appt-1',
      phone: '+15551112222',
      from: '+1',
      message: 'Reminder',
    };

    await expect(appointmentReminder(db, sendSMS, payload)).rejects.toThrow('SMS service unavailable');
  });

  it('propagates db.query failure without silencing it', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('DB failure')) };
    const payload = {
      appointmentId: 'appt-1',
      phone: '+15551112222',
      message: 'Reminder',
      from: '+1',
    };

    await expect(appointmentReminder(db, sendSMS, payload)).rejects.toThrow('DB failure');
  });

  it('uses empty string when message is absent', async () => {
    const db = buildDb();
    const payload = { phone: '+15551112222', from: '+1' };

    await appointmentReminder(db, sendSMS, payload);

    expect(sendSMS).toHaveBeenCalledWith('+15551112222', '', '+1', db, undefined);
  });
});
