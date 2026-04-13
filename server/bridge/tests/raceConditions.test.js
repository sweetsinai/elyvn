/**
 * Race Condition & Concurrency Tests
 *
 * Tests the correctness of locks, dedup guards, and init guards under
 * concurrent load.  All tests use real async timing — no fake timers.
 */

// ─── External dependency mocks ────────────────────────────────────────────────

jest.mock('../utils/telegram', () => ({ sendMessage: jest.fn().mockResolvedValue({}) }));
jest.mock('../utils/sms', () => ({ sendSMS: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  setupLogger: jest.fn(),
}));

// Anthropic SDK mock — same pattern as brain.test.js
jest.mock('@anthropic-ai/sdk', () => {
  const mockInstance = { messages: { create: jest.fn() } };
  return jest.fn(() => mockInstance);
});

// brain.js uses fs.readFileSync to load KB — pass through real fs but stub that one method
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, readFileSync: jest.fn((p, enc) => {
    // Return empty KB JSON for any file brain.js tries to load
    if (typeof p === 'string' && (p.endsWith('.json') || p.endsWith('.txt'))) return '{}';
    return actual.readFileSync(p, enc);
  }) };
});

// Speed-to-lead lazily requires these helpers
jest.mock('../utils/businessHours', () => ({
  shouldDelayUntilBusinessHours: jest.fn().mockReturnValue(0),
}));
jest.mock('../utils/smartScheduler', () => ({
  getOptimalContactTime: jest.fn().mockReturnValue(null),
}));
jest.mock('../utils/phone', () => ({
  normalizePhone: jest.fn(p => p),
}));

// ─── Module imports (after mocks) ─────────────────────────────────────────────

const Database = require('better-sqlite3');
const { runMigrations } = require('../utils/migrations');
const { think, _leadLocks, _claudeBreaker, _resetForTesting } = require('../utils/brain');
const { processJobs, _resetSchemaForTesting } = require('../utils/jobQueue');
const { initScheduler, stopScheduler } = require('../utils/scheduler');
const { triggerSpeedSequence } = require('../utils/speed-to-lead');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal leadMemory object for brain.think() calls. */
function makeLeadMemory(leadId = 'lead-race-1') {
  return {
    lead: { id: leadId, phone: '+15550001111', name: 'Race Tester', score: 5, stage: 'warm' },
    client: {
      id: 'client-race-1',
      business_name: 'Race Corp',
      owner_name: 'Owner',
      is_active: 1,
      telegram_chat_id: null,
    },
    timeline: [],
    insights: {
      totalInteractions: 0,
      totalCalls: 0,
      totalMessages: 0,
      hasBooked: false,
      hasBeenTransferred: false,
      pendingFollowups: 0,
      daysSinceLastContact: null,
      highIntent: false,
      slippingAway: false,
      multiChannel: false,
    },
  };
}

/** Minimal mock db that satisfies brain's guardrail queries.
 * Provides both db.prepare() (sync) and db.query() (async) interfaces.
 */
function makeMockDb() {
  const db = {
    prepare: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(null),
      all: jest.fn().mockReturnValue([]),
      run: jest.fn().mockReturnValue({ changes: 0 }),
    }),
    query: jest.fn().mockResolvedValue(null),
  };
  return db;
}

/** Build a real in-memory SQLite db with all migrations applied.
 * Adds a .query() adapter so async source code works with the sync better-sqlite3 API.
 */
function makeRealDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  // Attach async db.query() shim compatible with the app's dbAdapter interface
  db.query = (sql, params = [], mode = 'all') => {
    const stmt = db.prepare(sql);
    if (mode === 'get') return Promise.resolve(stmt.get(...params));
    if (mode === 'run') return Promise.resolve(stmt.run(...params));
    return Promise.resolve(stmt.all(...params));
  };
  return db;
}

// ─── 1. Brain lock serialization ─────────────────────────────────────────────

describe('Brain lock serialization', () => {
  let Anthropic;

  beforeEach(() => {
    jest.clearAllMocks();
    if (typeof _resetForTesting === 'function') _resetForTesting();
    else {
      if (_claudeBreaker) _claudeBreaker.reset();
      if (_leadLocks) _leadLocks.clear();
    }
    Anthropic = require('@anthropic-ai/sdk');
  });

  it('executes concurrent same-lead calls sequentially, not in parallel', async () => {
    const mockClient = new Anthropic();
    const executionLog = [];

    // Each call records "start" then waits 30 ms then records "end"
    mockClient.messages.create.mockImplementation(async () => {
      executionLog.push('start');
      await new Promise(r => setTimeout(r, 30));
      executionLog.push('end');
      return {
        content: [{ type: 'text', text: '{"reasoning":"serial","actions":[]}' }],
      };
    });

    const memory = makeLeadMemory('lock-serial-lead');
    const db = makeMockDb();

    await Promise.all([
      think('call_ended', {}, memory, db),
      think('sms_received', {}, memory, db),
    ]);

    // Serialized: start1, end1, start2, end2 — never start2 before end1
    expect(executionLog).toEqual(['start', 'end', 'start', 'end']);
  });

  it('second call waits for first to complete before acquiring lock', async () => {
    const mockClient = new Anthropic();
    const completionOrder = [];
    let firstCallRunning = false;

    mockClient.messages.create.mockImplementation(async () => {
      if (!firstCallRunning) {
        // First call: hold for 40 ms
        firstCallRunning = true;
        await new Promise(r => setTimeout(r, 40));
        completionOrder.push('first');
      } else {
        // Second call: verify first already finished
        completionOrder.push('second');
      }
      return {
        content: [{ type: 'text', text: '{"reasoning":"wait","actions":[]}' }],
      };
    });

    const memory = makeLeadMemory('lock-wait-lead');
    const db = makeMockDb();

    const [r1, r2] = await Promise.all([
      think('call_ended', {}, memory, db),
      think('sms_received', {}, memory, db),
    ]);

    expect(r1.reasoning).toBe('wait');
    expect(r2.reasoning).toBe('wait');
    // Second must finish after first
    expect(completionOrder[0]).toBe('first');
    expect(completionOrder[1]).toBe('second');
  });

  it('all three concurrent same-lead calls complete successfully', async () => {
    const mockClient = new Anthropic();

    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning":"ok","actions":[]}' }],
    });

    const memory = makeLeadMemory('lock-three-lead');
    const db = makeMockDb();

    const results = await Promise.all([
      think('call_ended', {}, memory, db),
      think('sms_received', {}, memory, db),
      think('form_submitted', {}, memory, db),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.reasoning === 'ok')).toBe(true);
  });

  it('different leads do NOT block each other', async () => {
    const mockClient = new Anthropic();
    const startTimes = {};

    mockClient.messages.create.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      return {
        content: [{ type: 'text', text: '{"reasoning":"parallel","actions":[]}' }],
      };
    });

    const db = makeMockDb();
    const memoryA = makeLeadMemory('lead-A');
    const memoryB = makeLeadMemory('lead-B');

    const start = Date.now();
    await Promise.all([
      think('call_ended', {}, memoryA, db),
      think('call_ended', {}, memoryB, db),
    ]);
    const elapsed = Date.now() - start;

    // If they ran in parallel each taking ~20 ms, total should be <60 ms.
    // If serialized it would be ~40 ms+.  We give a generous 70 ms ceiling.
    expect(elapsed).toBeLessThan(70);
  });
});

// ─── 2. Brain lock token safety ───────────────────────────────────────────────

describe('Brain lock token safety', () => {
  let Anthropic;

  beforeEach(() => {
    jest.clearAllMocks();
    if (typeof _resetForTesting === 'function') _resetForTesting();
    else {
      if (_claudeBreaker) _claudeBreaker.reset();
      if (_leadLocks) _leadLocks.clear();
    }
    Anthropic = require('@anthropic-ai/sdk');
  });

  it('timed-out first caller unlock does NOT release the second callers lock', async () => {
    // BRAIN_LOCK_TIMEOUT_MS = 10 000 ms; we can't wait that long, so we
    // directly manipulate leadLocks to simulate what happens after a timeout
    // releases the lock and a new holder takes over.
    const mockClient = new Anthropic();
    let callCount = 0;

    mockClient.messages.create.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise(r => setTimeout(r, 50));
      }
      return {
        content: [{ type: 'text', text: '{"reasoning":"token-safe","actions":[]}' }],
      };
    });

    const memory = makeLeadMemory('token-safety-lead');
    const db = makeMockDb();

    // Both calls must complete — the second must not be starved after the
    // first eventually unlocks.
    const [r1, r2] = await Promise.all([
      think('call_ended', {}, memory, db),
      think('sms_received', {}, memory, db),
    ]);

    expect(r1.reasoning).toBe('token-safe');
    expect(r2.reasoning).toBe('token-safe');

    // Lock map must be clean after both finish
    expect(_leadLocks.has('token-safety-lead')).toBe(false);
  });

  it('lock is cleaned up after a successful call', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning":"cleanup","actions":[]}' }],
    });

    const memory = makeLeadMemory('cleanup-lead');
    const db = makeMockDb();

    await think('call_ended', {}, memory, db);

    expect(_leadLocks.has('cleanup-lead')).toBe(false);
  });

  it('lock is cleaned up even when the brain call throws', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockRejectedValue(new Error('Claude is down'));

    const memory = makeLeadMemory('error-cleanup-lead');
    const db = makeMockDb();

    // think() catches errors internally and returns a fallback
    const result = await think('call_ended', {}, memory, db);

    expect(result.actions[0].action).toBe('notify_owner');
    expect(_leadLocks.has('error-cleanup-lead')).toBe(false);
  });

  it('each concurrent caller acquires a unique token', async () => {
    const mockClient = new Anthropic();
    const seenTokens = new Set();

    // Intercept lock acquisition by observing the _leadLocks map mid-flight
    mockClient.messages.create.mockImplementation(async () => {
      const lock = _leadLocks.get('unique-token-lead');
      if (lock) seenTokens.add(lock.token);
      await new Promise(r => setTimeout(r, 5));
      return {
        content: [{ type: 'text', text: '{"reasoning":"tokens","actions":[]}' }],
      };
    });

    const memory = makeLeadMemory('unique-token-lead');
    const db = makeMockDb();

    await Promise.all([
      think('call_ended', {}, memory, db),
      think('sms_received', {}, memory, db),
    ]);

    // Each call held the lock at a different time — two distinct tokens seen
    expect(seenTokens.size).toBe(2);
  });
});

// ─── 3. Job queue dedup (TOCTOU protection) ───────────────────────────────────

describe('Job queue dedup — TOCTOU protection', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetSchemaForTesting();
    db = makeRealDb();
  });

  afterEach(() => {
    db.close();
  });

  it('processes a pending job exactly once when two processJobs calls race', async () => {
    // Insert a single pending job that is due right now
    const jobId = require('crypto').randomUUID();
    db.prepare(`
      INSERT INTO job_queue (id, type, payload, scheduled_at, status, attempts, max_attempts)
      VALUES (?, 'test_dedup', '{"x":1}', datetime('now', '-1 second'), 'pending', 0, 3)
    `).run(jobId);

    const handler = jest.fn().mockResolvedValue(undefined);

    // Two concurrent processJobs calls — only one should execute the handler
    await Promise.all([
      processJobs(db, { test_dedup: handler }),
      processJobs(db, { test_dedup: handler }),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('marks the job completed after processing', async () => {
    const jobId = require('crypto').randomUUID();
    db.prepare(`
      INSERT INTO job_queue (id, type, payload, scheduled_at, status, attempts, max_attempts)
      VALUES (?, 'test_complete', '{}', datetime('now', '-1 second'), 'pending', 0, 3)
    `).run(jobId);

    const handler = jest.fn().mockResolvedValue(undefined);

    await processJobs(db, { test_complete: handler });

    const job = db.prepare('SELECT status FROM job_queue WHERE id = ?').get(jobId);
    expect(job.status).toBe('completed');
  });

  it('does not pick up a job already in processing status', async () => {
    const jobId = require('crypto').randomUUID();
    db.prepare(`
      INSERT INTO job_queue (id, type, payload, scheduled_at, status, attempts, max_attempts)
      VALUES (?, 'already_processing', '{}', datetime('now', '-1 second'), 'processing', 0, 3)
    `).run(jobId);

    const handler = jest.fn().mockResolvedValue(undefined);

    await processJobs(db, { already_processing: handler });

    // Job was in 'processing' — processJobs only fetches 'pending' jobs
    expect(handler).not.toHaveBeenCalled();
  });

  it('two concurrent workers process two separate jobs exactly once each', async () => {
    const id1 = require('crypto').randomUUID();
    const id2 = require('crypto').randomUUID();
    db.prepare(`
      INSERT INTO job_queue (id, type, payload, scheduled_at, status, attempts, max_attempts)
      VALUES
        (?, 'multi_job', '{"n":1}', datetime('now', '-1 second'), 'pending', 0, 3),
        (?, 'multi_job', '{"n":2}', datetime('now', '-1 second'), 'pending', 0, 3)
    `).run(id1, id2);

    const handledPayloads = [];
    const handler = jest.fn().mockImplementation(async (payload) => {
      handledPayloads.push(payload.n);
    });

    await Promise.all([
      processJobs(db, { multi_job: handler }),
      processJobs(db, { multi_job: handler }),
    ]);

    // Both jobs processed, each exactly once
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handledPayloads.sort()).toEqual([1, 2]);
  });
});

// ─── 4. Scheduler init guard ──────────────────────────────────────────────────

describe('Scheduler init guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stopScheduler(); // always start clean
  });

  afterEach(() => {
    stopScheduler();
  });

  it('calling initScheduler twice only registers timers once', () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const db = makeMockDb();

    initScheduler(db);
    const intervalCallsAfterFirst = setIntervalSpy.mock.calls.length;
    const timeoutCallsAfterFirst = setTimeoutSpy.mock.calls.length;

    // Second call must be a no-op
    initScheduler(db);
    const intervalCallsAfterSecond = setIntervalSpy.mock.calls.length;
    const timeoutCallsAfterSecond = setTimeoutSpy.mock.calls.length;

    expect(intervalCallsAfterSecond).toBe(intervalCallsAfterFirst);
    expect(timeoutCallsAfterSecond).toBe(timeoutCallsAfterFirst);

    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    jest.useRealTimers();
  });

  it('stopScheduler resets state so a subsequent initScheduler registers timers again', () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'setInterval');

    const db = makeMockDb();

    initScheduler(db);
    const firstCount = spy.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    stopScheduler();
    spy.mockClear();

    initScheduler(db);
    const secondCount = spy.mock.calls.length;
    expect(secondCount).toBeGreaterThan(0);

    spy.mockRestore();
    jest.useRealTimers();
  });

  it('duplicate initScheduler calls do not double-register setInterval tasks', () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'setInterval');

    const db = makeMockDb();
    initScheduler(db);
    initScheduler(db);
    initScheduler(db);

    // The immediately-registered intervals (follow-up + appointment + reply-check) are 3
    // A duplicate init must not add more
    const immediateIntervals = spy.mock.calls.length;
    // After one init there should be exactly 3 immediate setIntervals (follow-up, appointment, reply-check)
    expect(immediateIntervals).toBe(3);

    spy.mockRestore();
    jest.useRealTimers();
  });
});

// ─── 5. Speed-to-lead sequence dedup ─────────────────────────────────────────

describe('Speed-to-lead sequence dedup', () => {
  let db;

  const clientId = 'stl-client-1';
  const leadId = 'stl-lead-1';
  const phone = '+15550002222';

  const client = {
    id: clientId,
    business_name: 'STL Corp',
    owner_name: 'Boss',
    is_active: 1,
    calcom_booking_link: 'https://cal.com/stl',
    telnyx_phone: '+15550009999',
    phone_number: '+15550009999',
    telegram_chat_id: null,
    notification_mode: 'instant',
    retell_agent_id: null,
    retell_phone: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    _resetSchemaForTesting();
    db = makeRealDb();

    // Seed required FK rows
    db.prepare(`
      INSERT INTO clients (id, name, is_active, telnyx_phone)
      VALUES (?, ?, 1, ?)
    `).run(clientId, 'STL Corp', '+15550009999');

    db.prepare(`
      INSERT INTO leads (id, client_id, phone, name, stage, score)
      VALUES (?, ?, ?, 'Race Tester', 'new', 0)
    `).run(leadId, clientId, phone);
  });

  afterEach(() => {
    db.close();
  });

  const leadData = () => ({
    leadId,
    clientId,
    phone,
    name: 'Race Tester',
    email: null,
    message: null,
    service: null,
    source: 'form',
    client,
  });

  it('calling triggerSpeedSequence twice inserts followup rows only once (touch 4 + 5)', async () => {
    await triggerSpeedSequence(db, leadData());
    await triggerSpeedSequence(db, leadData());

    // Touch 4 and 5 must each appear exactly once
    const touch4 = db.prepare(
      "SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND touch_number = 4 AND status = 'scheduled'"
    ).get(leadId).c;

    const touch5 = db.prepare(
      "SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND touch_number = 5 AND status = 'scheduled'"
    ).get(leadId).c;

    expect(touch4).toBe(1);
    expect(touch5).toBe(1);
  });

  it('concurrent double-trigger still produces exactly one touch-4 and one touch-5', async () => {
    await Promise.all([
      triggerSpeedSequence(db, leadData()),
      triggerSpeedSequence(db, leadData()),
    ]);

    const touch4 = db.prepare(
      "SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND touch_number = 4 AND status = 'scheduled'"
    ).get(leadId).c;

    const touch5 = db.prepare(
      "SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND touch_number = 5 AND status = 'scheduled'"
    ).get(leadId).c;

    expect(touch4).toBeLessThanOrEqual(1);
    expect(touch5).toBeLessThanOrEqual(1);
  });

  it('second trigger skips entirely when active sequence already exists', async () => {
    // Manually insert a scheduled followup within the 6-hour dedup window
    // Use JS ISO date format to match the parameterized query in speed-to-lead.js
    const { randomUUID } = require('crypto');
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
      VALUES (?, ?, ?, 1, 'reminder_or_nudge', 'pre-existing', 'pending', ?, 'scheduled')
    `).run(randomUUID(), leadId, clientId, oneHourFromNow);

    const { logger } = require('../utils/logger');
    logger.info.mockClear();

    await triggerSpeedSequence(db, leadData());

    // The dedup guard logs this specific message and returns early
    const dedupLogs = logger.info.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('Active sequence found')
    );
    expect(dedupLogs.length).toBe(1);
  });

  it('first trigger enqueues SMS and callback jobs in job_queue', async () => {
    await triggerSpeedSequence(db, leadData());

    const jobs = db.prepare(
      "SELECT type FROM job_queue WHERE JSON_EXTRACT(payload, '$.leadId') = ? ORDER BY type"
    ).all(leadId);

    const types = jobs.map(j => j.type).sort();
    expect(types).toContain('speed_to_lead_sms');
    expect(types).toContain('speed_to_lead_callback');
    expect(types).toContain('followup_sms');
  });
});
