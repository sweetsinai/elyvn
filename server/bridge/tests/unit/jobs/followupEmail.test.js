/**
 * Unit tests for jobs/handlers/followupEmail.js
 * Covers: interestedFollowupEmail and noreplyFollowup handlers
 */

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'msg-ok' });
const mockTransport = { sendMail: mockSendMail };

jest.mock('../../../utils/mailer', () => ({
  getTransporter: jest.fn(() => mockTransport),
}));

jest.mock('../../../utils/config', () => ({
  outreach: {
    bookingLink: 'https://cal.com/default',
    senderName: 'Sohan',
  },
}));

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../utils/jobQueue', () => ({
  enqueueJob: jest.fn(),
}));

const { interestedFollowupEmail, noreplyFollowup } = require('../../../jobs/handlers/followupEmail');
const { getTransporter } = require('../../../utils/mailer');
const { logger } = require('../../../utils/logger');
const { enqueueJob } = require('../../../utils/jobQueue');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDb(overrides = {}) {
  const defaults = {
    prospectRow: { id: 'p-1', status: 'new', phone: '+15551112222', business_name: 'Acme', industry: 'HVAC', city: 'Austin' },
    bookingRow: null,
    recentEmailRow: null,
    replyRow: null,
  };
  const cfg = { ...defaults, ...overrides };

  return {
    query: jest.fn(async (sql, params, method) => {
      if (method === 'run') return { changes: 1 };
      if (sql.includes('SELECT * FROM prospects'))         return cfg.prospectRow;
      if (sql.includes('FROM appointments'))               return cfg.bookingRow;
      if (sql.includes('reply_text IS NOT NULL'))         return cfg.replyRow;
      if (sql.includes('FROM emails_sent') && sql.includes('datetime')) return cfg.recentEmailRow;
      return null;
    }),
  };
}

const basePayload = {
  prospect_id: 'p-1',
  to_email: 'acme@example.com',
  from_email: 'sohan@elyvn.ai',
  subject: 'AI receptionist for Acme',
  booking_link: 'https://cal.com/sohan',
  sender_name: 'Sohan',
};

// ---------------------------------------------------------------------------
// interestedFollowupEmail
// ---------------------------------------------------------------------------

describe('interestedFollowupEmail', () => {
  let captureException;

  beforeEach(() => {
    jest.clearAllMocks();
    captureException = jest.fn();
    getTransporter.mockReturnValue(mockTransport);
    mockSendMail.mockResolvedValue({ messageId: 'ok' });
  });

  it('sends follow-up email on the happy path', async () => {
    const db = buildDb();

    await interestedFollowupEmail(db, captureException, basePayload);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'sohan@elyvn.ai',
        to: 'acme@example.com',
        subject: expect.stringContaining('Re:'),
        text: expect.stringContaining('https://cal.com/sohan'),
      })
    );
  });

  it('skips when prospect status is already booked', async () => {
    const db = buildDb({ prospectRow: { id: 'p-1', status: 'booked', phone: '+1', business_name: 'X' } });

    await interestedFollowupEmail(db, captureException, basePayload);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping follow-up')
    );
  });

  it('skips when prospect row is missing', async () => {
    const db = buildDb({ prospectRow: null });

    await interestedFollowupEmail(db, captureException, basePayload);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('skips when an appointment already exists for the prospect', async () => {
    const db = buildDb({ bookingRow: { 1: 1 } });

    await interestedFollowupEmail(db, captureException, basePayload);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('has a booking')
    );
  });

  it('skips when a recent duplicate email was already sent', async () => {
    const db = buildDb({ recentEmailRow: { id: 'email-99' } });

    await interestedFollowupEmail(db, captureException, basePayload);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate email')
    );
  });

  it('returns early (no throw) when SMTP is not configured', async () => {
    getTransporter.mockReturnValue(null);
    const db = buildDb();

    await expect(interestedFollowupEmail(db, captureException, basePayload)).resolves.toBeUndefined();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('SMTP not configured')
    );
  });

  it('handles sendMail failure gracefully — logs and calls captureException', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP timeout'));
    const db = buildDb();

    await expect(interestedFollowupEmail(db, captureException, basePayload)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('interested_followup_email error:'),
      'SMTP timeout'
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'interested_followup_email' })
    );
  });

  it('handles db.query failure gracefully — logs error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('DB connection lost')) };

    await expect(interestedFollowupEmail(db, captureException, basePayload)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('interested_followup_email error:'),
      'DB connection lost'
    );
  });

  it('does not crash when captureException is not provided', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP down'));
    const db = buildDb();

    await expect(interestedFollowupEmail(db, null, basePayload)).resolves.toBeUndefined();
  });

  it('falls back to config booking link when payload omits it', async () => {
    const db = buildDb();
    const payload = { ...basePayload };
    delete payload.booking_link;

    await interestedFollowupEmail(db, captureException, payload);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('https://cal.com/default'),
      })
    );
  });

  it('personalises greeting with first word of business_name', async () => {
    const db = buildDb({
      prospectRow: { id: 'p-1', status: 'new', phone: '+1', business_name: 'Acme Plumbing' },
    });

    await interestedFollowupEmail(db, captureException, basePayload);

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.text).toMatch(/Hi Acme/);
  });
});

// ---------------------------------------------------------------------------
// noreplyFollowup
// ---------------------------------------------------------------------------

describe('noreplyFollowup', () => {
  let captureException;

  const noreplyPayload = {
    prospect_id: 'p-1',
    to_email: 'acme@example.com',
    from_email: 'sohan@elyvn.ai',
    original_subject: 'AI receptionist for Acme',
    booking_link: 'https://cal.com/sohan',
    sender_name: 'Sohan',
    campaign_id: 'camp-1',
    day: 3,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    captureException = jest.fn();
    getTransporter.mockReturnValue(mockTransport);
    mockSendMail.mockResolvedValue({ messageId: 'ok' });
  });

  it('sends Day 3 follow-up and schedules Day 7 on happy path', async () => {
    const db = buildDb();

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledWith(
      db,
      'noreply_followup',
      expect.objectContaining({ day: 7 }),
      expect.any(String),
      expect.any(String)  // dedup key (e.g. noreply_d7_<prospect_id>)
    );
  });

  it('sends Day 7 follow-up and does NOT schedule further emails', async () => {
    const db = buildDb();

    await noreplyFollowup(db, captureException, { ...noreplyPayload, day: 7 });

    expect(mockSendMail).toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('skips when prospect is already booked', async () => {
    const db = buildDb({
      prospectRow: { id: 'p-1', status: 'booked', phone: '+1', business_name: 'X' },
    });

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('skips when prospect is unsubscribed', async () => {
    const db = buildDb({
      prospectRow: { id: 'p-1', status: 'unsubscribed', phone: '+1', business_name: 'X' },
    });

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('skips when prospect is bounced', async () => {
    const db = buildDb({
      prospectRow: { id: 'p-1', status: 'bounced', phone: '+1', business_name: 'X' },
    });

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('skips when prospect status is interested (moved past outreach stage)', async () => {
    const db = buildDb({
      prospectRow: { id: 'p-1', status: 'interested', phone: '+1', business_name: 'X' },
    });

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('skips when prospect row is missing', async () => {
    const db = buildDb({ prospectRow: null });

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('skips when prospect has already replied', async () => {
    const db = buildDb({ replyRow: { 1: 1 } });

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('prospect replied')
    );
  });

  it('skips on duplicate email within dedup window', async () => {
    const db = buildDb({ recentEmailRow: { id: 'email-dupe' } });

    await noreplyFollowup(db, captureException, noreplyPayload);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate email')
    );
  });

  it('returns early without throwing when SMTP is not configured', async () => {
    getTransporter.mockReturnValue(null);
    const db = buildDb();

    await expect(noreplyFollowup(db, captureException, noreplyPayload)).resolves.toBeUndefined();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('handles sendMail failure gracefully — logs and calls captureException', async () => {
    mockSendMail.mockRejectedValue(new Error('Connection refused'));
    const db = buildDb();

    await expect(noreplyFollowup(db, captureException, noreplyPayload)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('noreply_followup error:'),
      'Connection refused'
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'noreply_followup' })
    );
  });

  it('handles db.query failure gracefully — logs error', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('SQLITE_BUSY')) };

    await expect(noreplyFollowup(db, captureException, noreplyPayload)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('noreply_followup error:'),
      'SQLITE_BUSY'
    );
  });

  it('writes an emails_sent record after sending', async () => {
    const db = buildDb();

    await noreplyFollowup(db, captureException, noreplyPayload);

    // db.query called with 'run' method for the INSERT
    const insertCall = db.query.mock.calls.find(
      ([sql, , method]) => sql.includes('INSERT INTO emails_sent') && method === 'run'
    );
    expect(insertCall).toBeDefined();
  });

  it('uses day=3 body template for day <= 3', async () => {
    const db = buildDb();

    await noreplyFollowup(db, captureException, { ...noreplyPayload, day: 3 });

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.text).toMatch(/Quick follow-up/);
  });

  it('uses day=7 body template for day > 3', async () => {
    const db = buildDb();

    await noreplyFollowup(db, captureException, { ...noreplyPayload, day: 7 });

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.text).toMatch(/Last note from me/);
  });

  it('defaults to day=3 when day is not provided in payload', async () => {
    const db = buildDb();
    const payload = { ...noreplyPayload };
    delete payload.day;

    await noreplyFollowup(db, captureException, payload);

    expect(mockSendMail).toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalled(); // day <= 3 schedules day 7
  });

  it('does not crash when captureException is not provided', async () => {
    mockSendMail.mockRejectedValue(new Error('oops'));
    const db = buildDb();

    await expect(noreplyFollowup(db, null, noreplyPayload)).resolves.toBeUndefined();
  });
});
