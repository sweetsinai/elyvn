/**
 * Tests for utils/autoClassify.js
 *
 * autoClassifyReplies:
 *   - fetches unclassified email replies from the DB
 *   - calls classifyReply (AI) for each one
 *   - updates reply_classification in emails_sent
 *   - optionally updates leads.stage (confidence gate)
 *   - records opt-out for UNSUBSCRIBE
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock replyClassifier so we control what AI returns
jest.mock('../utils/replyClassifier', () => ({
  classifyReply: jest.fn(),
}));

// Mock optOut to capture calls
jest.mock('../utils/optOut', () => ({
  recordOptOut: jest.fn(),
  isOptedOut: jest.fn().mockResolvedValue(false),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

const { autoClassifyReplies } = require('../utils/autoClassify');
const { classifyReply } = require('../utils/replyClassifier');
const { recordOptOut } = require('../utils/optOut');
const { logger } = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock db whose query() returns different values keyed by SQL substring.
 * The 'unclassified' key uses a callback to return a fresh array each call so
 * tests can mutate it independently.
 */
function makeDb(opts = {}) {
  const {
    unclassified = [],
    alreadyClassified = null, // idempotency row
    lead = null,
    leadByEmail = null,
    clientLead = null,
  } = opts;

  return {
    query: jest.fn(async (sql, params = [], mode = 'all') => {
      // Main fetch of unclassified rows
      if (sql.includes('reply_text IS NOT NULL AND es.reply_classification IS NULL')) {
        return unclassified;
      }
      // Idempotency check
      if (sql.includes('SELECT reply_classification FROM emails_sent WHERE id')) {
        return alreadyClassified;
      }
      // UPDATE emails_sent (classification update or needs_review)
      if (sql.includes('UPDATE emails_sent')) {
        return { changes: 1 };
      }
      // Lead lookup by prospect_id
      if (sql.includes("SELECT id FROM leads WHERE prospect_id")) {
        return lead;
      }
      // Lead lookup by email
      if (sql.includes("SELECT id FROM leads WHERE email")) {
        return leadByEmail;
      }
      // UPDATE leads
      if (sql.includes('UPDATE leads')) {
        return { changes: 1 };
      }
      // Client lookup for opt-out
      if (sql.includes('SELECT client_id FROM leads WHERE prospect_id')) {
        return clientLead;
      }
      // Default
      if (mode === 'get') return undefined;
      return [];
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('autoClassifyReplies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── No unclassified replies ─────────────────────────────────────────────────

  it('returns zero classified when there are no unclassified replies', async () => {
    const db = makeDb({ unclassified: [] });

    const result = await autoClassifyReplies(db);

    expect(result.classified).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.message).toContain('No unclassified');
    expect(classifyReply).not.toHaveBeenCalled();
  });

  // ── INTERESTED — high confidence ────────────────────────────────────────────

  it('classifies INTERESTED reply and updates lead stage', async () => {
    const email = {
      id: 'e1',
      reply_text: 'Yes, I am very interested!',
      subject: 'Demo',
      prospect_id: 'p1',
      to_email: 'buyer@example.com',
      prospect_phone: null,
    };

    classifyReply.mockResolvedValue({
      classification: 'INTERESTED',
      confidence: 0.95,
      summary: 'Prospect wants a demo',
    });

    const db = makeDb({
      unclassified: [email],
      alreadyClassified: null, // not yet classified
      lead: { id: 'lead1' },
    });

    const result = await autoClassifyReplies(db);

    expect(result.classified).toBe(1);
    expect(result.results[0]).toMatchObject({
      id: 'e1',
      classification: 'INTERESTED',
      summary: 'Prospect wants a demo',
    });

    // Should have updated leads.stage to 'interested'
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE leads'),
      ['interested', 'lead1'],
      'run'
    );
  });

  // ── NOT_INTERESTED — high confidence ────────────────────────────────────────

  it('classifies NOT_INTERESTED and maps stage to not_interested', async () => {
    classifyReply.mockResolvedValue({
      classification: 'NOT_INTERESTED',
      confidence: 0.9,
      summary: 'Not a fit',
    });

    const db = makeDb({
      unclassified: [{ id: 'e2', reply_text: 'No thanks', subject: null, prospect_id: 'p2', to_email: 'x@x.com', prospect_phone: null }],
      alreadyClassified: null,
      lead: { id: 'lead2' },
    });

    const result = await autoClassifyReplies(db);

    expect(result.classified).toBe(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE leads'),
      ['not_interested', 'lead2'],
      'run'
    );
  });

  // ── QUESTION — high confidence ───────────────────────────────────────────────

  it('classifies QUESTION and maps stage to engaged', async () => {
    classifyReply.mockResolvedValue({
      classification: 'QUESTION',
      confidence: 0.85,
      summary: 'Has a question',
    });

    const db = makeDb({
      unclassified: [{ id: 'e3', reply_text: 'How does it work?', subject: 'Q', prospect_id: 'p3', to_email: 'y@x.com', prospect_phone: null }],
      alreadyClassified: null,
      lead: { id: 'lead3' },
    });

    const result = await autoClassifyReplies(db);

    expect(result.classified).toBe(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE leads'),
      ['engaged', 'lead3'],
      'run'
    );
  });

  // ── UNSUBSCRIBE — records opt-out ────────────────────────────────────────────

  it('classifies UNSUBSCRIBE, records opt-out when phone and client_id available', async () => {
    classifyReply.mockResolvedValue({
      classification: 'UNSUBSCRIBE',
      confidence: 0.98,
      summary: 'Please remove me',
    });

    const db = makeDb({
      unclassified: [{
        id: 'e4',
        reply_text: 'Unsubscribe me',
        subject: 'Stop',
        prospect_id: 'p4',
        to_email: 'unsub@x.com',
        prospect_phone: '+12125551234',
      }],
      alreadyClassified: null,
      lead: { id: 'lead4' },
      clientLead: { client_id: 'client1' },
    });

    await autoClassifyReplies(db);

    expect(recordOptOut).toHaveBeenCalledWith(
      db,
      '+12125551234',
      'client1',
      'email_unsubscribe'
    );
  });

  it('does NOT record opt-out when prospect_phone is null', async () => {
    classifyReply.mockResolvedValue({
      classification: 'UNSUBSCRIBE',
      confidence: 0.95,
      summary: 'Remove me',
    });

    const db = makeDb({
      unclassified: [{
        id: 'e5',
        reply_text: 'Stop',
        subject: null,
        prospect_id: 'p5',
        to_email: 'x@x.com',
        prospect_phone: null, // no phone
      }],
      alreadyClassified: null,
    });

    await autoClassifyReplies(db);

    expect(recordOptOut).not.toHaveBeenCalled();
  });

  // ── Confidence gate ──────────────────────────────────────────────────────────

  it('marks as needs_review and skips stage update when confidence < 0.7', async () => {
    classifyReply.mockResolvedValue({
      classification: 'INTERESTED',
      confidence: 0.5,
      summary: 'Maybe interested',
    });

    const db = makeDb({
      unclassified: [{ id: 'e6', reply_text: 'Maybe', subject: null, prospect_id: 'p6', to_email: 'z@x.com', prospect_phone: null }],
      alreadyClassified: null,
      lead: { id: 'lead6' },
    });

    await autoClassifyReplies(db);

    // Should NOT update leads.stage
    const updateLeadCalls = db.query.mock.calls.filter(c => c[0].includes('UPDATE leads'));
    expect(updateLeadCalls).toHaveLength(0);

    // Should update to needs_review
    const needsReviewCalls = db.query.mock.calls.filter(
      c => c[0].includes('UPDATE emails_sent') && JSON.stringify(c[1]).includes('needs_review')
    );
    expect(needsReviewCalls.length).toBeGreaterThan(0);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Low confidence'));
  });

  it('exactly at threshold 0.7 — auto-updates stage', async () => {
    classifyReply.mockResolvedValue({
      classification: 'INTERESTED',
      confidence: 0.7,
      summary: 'At threshold',
    });

    const db = makeDb({
      unclassified: [{ id: 'e7', reply_text: 'Interested', subject: null, prospect_id: 'p7', to_email: 'a@x.com', prospect_phone: null }],
      alreadyClassified: null,
      lead: { id: 'lead7' },
    });

    await autoClassifyReplies(db);

    const updateLeadCalls = db.query.mock.calls.filter(c => c[0].includes('UPDATE leads'));
    expect(updateLeadCalls).toHaveLength(1);
  });

  // ── Idempotency ──────────────────────────────────────────────────────────────

  it('skips already-classified emails (idempotency check)', async () => {
    classifyReply.mockResolvedValue({ classification: 'INTERESTED', confidence: 0.9 });

    const db = makeDb({
      unclassified: [{ id: 'e8', reply_text: 'Already done', subject: null, prospect_id: 'p8', to_email: 'b@x.com', prospect_phone: null }],
      alreadyClassified: { reply_classification: 'INTERESTED' }, // already set
    });

    const result = await autoClassifyReplies(db);

    expect(result.classified).toBe(0);
    expect(classifyReply).not.toHaveBeenCalled();
  });

  // ── Lead not found — fallback by email ──────────────────────────────────────

  it('falls back to lead lookup by email when prospect_id lookup returns null', async () => {
    classifyReply.mockResolvedValue({
      classification: 'INTERESTED',
      confidence: 0.9,
      summary: 'Interested',
    });

    const db = makeDb({
      unclassified: [{ id: 'e9', reply_text: 'Yes!', subject: null, prospect_id: 'p9', to_email: 'lead@x.com', prospect_phone: null }],
      alreadyClassified: null,
      lead: null,          // first lookup fails
      leadByEmail: { id: 'lead9' }, // second lookup succeeds
    });

    await autoClassifyReplies(db);

    const updateLeadCalls = db.query.mock.calls.filter(c => c[0].includes('UPDATE leads'));
    expect(updateLeadCalls).toHaveLength(1);
  });

  it('skips stage update when no lead found by either method', async () => {
    classifyReply.mockResolvedValue({
      classification: 'INTERESTED',
      confidence: 0.9,
      summary: 'Interested',
    });

    const db = makeDb({
      unclassified: [{ id: 'e10', reply_text: 'Yes!', subject: null, prospect_id: 'p10', to_email: 'orphan@x.com', prospect_phone: null }],
      alreadyClassified: null,
      lead: null,
      leadByEmail: null,
    });

    await autoClassifyReplies(db);

    const updateLeadCalls = db.query.mock.calls.filter(c => c[0].includes('UPDATE leads'));
    expect(updateLeadCalls).toHaveLength(0);
  });

  // ── Per-email error handling ──────────────────────────────────────────────────

  it('continues processing remaining emails when one fails', async () => {
    classifyReply
      .mockRejectedValueOnce(new Error('AI timeout'))
      .mockResolvedValueOnce({ classification: 'NOT_INTERESTED', confidence: 0.9, summary: 'Nope' });

    const emails = [
      { id: 'bad', reply_text: 'Oops', subject: null, prospect_id: 'p1', to_email: 'a@x.com', prospect_phone: null },
      { id: 'good', reply_text: 'No thanks', subject: null, prospect_id: 'p2', to_email: 'b@x.com', prospect_phone: null },
    ];

    const db = makeDb({ unclassified: emails, alreadyClassified: null });

    const result = await autoClassifyReplies(db);

    expect(result.classified).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ id: 'bad', error: 'AI timeout' });
    expect(result.results[1]).toMatchObject({ id: 'good', classification: 'NOT_INTERESTED' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error classifying email bad'),
      'AI timeout'
    );
  });

  // ── Batch count / message ────────────────────────────────────────────────────

  it('reports correct count message for partial success', async () => {
    classifyReply
      .mockResolvedValueOnce({ classification: 'INTERESTED', confidence: 0.9, summary: 'A' })
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ classification: 'QUESTION', confidence: 0.8, summary: 'C' });

    const emails = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      reply_text: `text ${i}`,
      subject: null,
      prospect_id: `p${i}`,
      to_email: `m${i}@x.com`,
      prospect_phone: null,
    }));

    const db = makeDb({ unclassified: emails, alreadyClassified: null });

    const result = await autoClassifyReplies(db);

    expect(result.message).toBe('Classified 2/3 replies');
    expect(result.classified).toBe(2);
  });

  // ── Fatal DB error ────────────────────────────────────────────────────────────

  it('throws on fatal DB error during initial fetch', async () => {
    const db = {
      query: jest.fn().mockRejectedValue(new Error('DB connection lost')),
    };

    await expect(autoClassifyReplies(db)).rejects.toThrow('DB connection lost');
    expect(logger.error).toHaveBeenCalledWith(
      '[autoClassify] Fatal error:',
      'DB connection lost'
    );
  });

  // ── Stage update error is non-fatal ──────────────────────────────────────────

  it('logs and continues when lead stage update fails', async () => {
    classifyReply.mockResolvedValue({ classification: 'INTERESTED', confidence: 0.9, summary: 'Yes' });

    let callCount = 0;
    const db = {
      query: jest.fn(async (sql, params = [], mode = 'all') => {
        callCount++;
        if (sql.includes('reply_text IS NOT NULL')) {
          return [{ id: 'e1', reply_text: 'Yes!', subject: null, prospect_id: 'p1', to_email: 'x@x.com', prospect_phone: null }];
        }
        if (sql.includes('SELECT reply_classification')) return null;
        if (sql.includes('UPDATE emails_sent')) return { changes: 1 };
        if (sql.includes('SELECT id FROM leads')) {
          throw new Error('DB locked');
        }
        return null;
      }),
    };

    const result = await autoClassifyReplies(db);

    // classified still counts (the main classification succeeded)
    expect(result.classified).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update lead stage for email e1'),
      'DB locked'
    );
  });

  // ── UNSUBSCRIBE opt-out error is non-fatal ────────────────────────────────────

  it('logs and continues when opt-out recording fails', async () => {
    classifyReply.mockResolvedValue({ classification: 'UNSUBSCRIBE', confidence: 0.95, summary: 'Unsub' });
    recordOptOut.mockImplementation(() => { throw new Error('opt-out DB error'); });

    const db = makeDb({
      unclassified: [{ id: 'e1', reply_text: 'Stop', subject: null, prospect_id: 'p1', to_email: 'x@x.com', prospect_phone: '+12125551234' }],
      alreadyClassified: null,
      clientLead: { client_id: 'client1' },
    });

    const result = await autoClassifyReplies(db);

    expect(result.classified).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record opt-out for email e1'),
      'opt-out DB error'
    );
  });

  // ── No prospect_id → skip stage update ───────────────────────────────────────

  it('skips lead stage update when prospect_id is null', async () => {
    classifyReply.mockResolvedValue({ classification: 'INTERESTED', confidence: 0.9, summary: 'Yes' });

    const db = makeDb({
      unclassified: [{ id: 'e1', reply_text: 'Yes', subject: null, prospect_id: null, to_email: 'x@x.com', prospect_phone: null }],
      alreadyClassified: null,
    });

    await autoClassifyReplies(db);

    const updateLeadCalls = db.query.mock.calls.filter(c => c[0].includes('UPDATE leads'));
    expect(updateLeadCalls).toHaveLength(0);
  });
});
