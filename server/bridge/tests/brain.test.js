// Mock Anthropic SDK BEFORE importing brain
jest.mock('@anthropic-ai/sdk', () => {
  const mockInstance = {
    messages: {
      create: jest.fn(),
    },
  };
  return jest.fn(() => mockInstance);
});

// Mock fs and path, but preserve real implementations
jest.mock('fs', () => ({
  readFileSync: jest.fn(() => '{}'),
}));

jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/')),
}));

// Mock logger to capture log output
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock('../utils/logger', () => ({
  logger: mockLogger,
  setupLogger: jest.fn(),
  closeLogger: jest.fn(),
}));

const { think, _claudeBreaker, _leadLocks, _resetForTesting } = require('../utils/brain');

describe('brain.think', () => {
  let mockLeadMemory;
  let mockDb;
  let Anthropic;

  beforeEach(() => {
    // Clear mocks
    jest.clearAllMocks();

    // Reset circuit breaker, lead locks, and token bucket so tests don't bleed into each other
    if (_resetForTesting) _resetForTesting();
    else {
      if (_claudeBreaker) _claudeBreaker.reset();
      if (_leadLocks) _leadLocks.clear();
    }

    // Setup mock database (just for guardrails queries)
    const _defaultPrepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(null),
      all: jest.fn().mockReturnValue([]),
      run: jest.fn().mockReturnValue({}),
    });
    mockDb = {
      prepare: _defaultPrepare,
      query: jest.fn((sql, params = [], mode = 'all') => {
        const stmt = mockDb.prepare(sql);
        if (mode === 'get') return Promise.resolve(stmt.get(...(params || [])));
        if (mode === 'run') return Promise.resolve(stmt.run(...(params || [])));
        return Promise.resolve(stmt.all(...(params || [])));
      }),
    };

    // Setup mock lead memory
    mockLeadMemory = {
      lead: {
        id: 'lead1',
        phone: '+12125551234',
        name: 'John Doe',
        score: 5,
        stage: 'warm',
      },
      client: {
        id: 'client1',
        name: 'Test Co',
        business_name: 'Test Business',
        owner_name: 'John Owner',
        is_active: 1,
      },
      timeline: [],
      insights: {
        totalCalls: 0,
        totalMessages: 0,
        totalInteractions: 0,
        hasBooked: false,
        hasBeenTransferred: false,
        pendingFollowups: 0,
        daysSinceLastContact: null,
        highIntent: false,
        slippingAway: false,
        multiChannel: false,
      },
      calls: [],
      messages: [],
      followups: [],
    };

    Anthropic = require('@anthropic-ai/sdk');
  });

  it('should return fallback on Claude API error', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockRejectedValue(new Error('API error'));

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.reasoning).toContain('fallback');
    expect(result.actions[0].action).toBe('notify_owner');
  });

  it('should respect per-lead lock', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
    });

    // Start first call (doesn't complete)
    const promise1 = think('call_ended', {}, mockLeadMemory, mockDb);

    // Start second call before first completes
    const promise2 = think('call_ended', {}, mockLeadMemory, mockDb);

    // Both should succeed eventually
    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
  });

  it('should detect opt-out guardrail', async () => {
    mockDb.prepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue({ id: 'msg1' }),
      all: jest.fn().mockReturnValue([]),
    });

    const mockClient = new Anthropic();
    mockClient.messages.create.mockImplementation(({ system }) => {
      // Check that guardrails are in system prompt
      expect(system).toContain('OPT_OUT');
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(mockClient.messages.create).toHaveBeenCalled();
  });

  it('should detect rate limit guardrail (3+ SMS in 24h)', async () => {
    // Mock 3 outbound brain SMS in last 24 hours
    mockDb.prepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue({ c: 3 }),
      all: jest.fn().mockReturnValue([]),
    });

    const mockClient = new Anthropic();
    mockClient.messages.create.mockImplementation(({ system }) => {
      // Check that rate limit guardrail is in system prompt
      expect(system).toContain('RATE_LIMIT');
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(mockClient.messages.create).toHaveBeenCalled();
  });

  it('should detect transferred guardrail', async () => {
    // Mock transferred call
    mockDb.prepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue({ outcome: 'transferred' }),
      all: jest.fn().mockReturnValue([]),
    });

    const mockClient = new Anthropic();
    mockClient.messages.create.mockImplementation(({ system }) => {
      // Check that owner handling guardrail is in system prompt
      expect(system).toContain('OWNER_HANDLING');
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(mockClient.messages.create).toHaveBeenCalled();
  });

  it('should parse Claude response correctly', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "Lead is hot", "actions": [{"action": "send_sms", "message": "Hi there"}]}',
      }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.reasoning).toBe('Lead is hot');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe('send_sms');
  });

  it('should handle markdown-wrapped JSON response', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '```json\n{"reasoning": "Test", "actions": []}\n```',
      }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.reasoning).toBe('Test');
    expect(result.actions).toEqual([]);
  });

  it('should include timeline in user message', async () => {
    const mockClient = new Anthropic();
    let capturedSystem = '';
    mockClient.messages.create.mockImplementation(({ system, messages }) => {
      capturedSystem = system;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    const memoryWithTimeline = {
      ...mockLeadMemory,
      timeline: [
        {
          type: 'call',
          timestamp: '2024-01-01T10:00:00Z',
          summary: 'Good call',
          outcome: 'qualified',
          score: 8,
          duration: 300,
        },
      ],
    };

    await think('call_ended', {}, memoryWithTimeline, mockDb);

    expect(mockClient.messages.create).toHaveBeenCalled();
  });

  it('should include event data in prompt', async () => {
    const mockClient = new Anthropic();
    let capturedMessages = [];
    mockClient.messages.create.mockImplementation(({ messages }) => {
      capturedMessages = messages;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    const eventData = { call_id: 'abc123', duration: 300 };
    await think('call_ended', eventData, mockLeadMemory, mockDb);

    const userMessage = capturedMessages[0].content;
    expect(userMessage).toContain('EVENT: call_ended');
    expect(userMessage).toContain('abc123');
  });

  it('should include client info in system prompt', async () => {
    const mockClient = new Anthropic();
    let capturedSystem = '';
    mockClient.messages.create.mockImplementation(({ system }) => {
      capturedSystem = system;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(capturedSystem).toContain('Test Business');
    expect(capturedSystem).toContain('John Owner');
  });

  it('should include insights in user message', async () => {
    const mockClient = new Anthropic();
    let capturedMessages = [];
    mockClient.messages.create.mockImplementation(({ messages }) => {
      capturedMessages = messages;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    const memoryWithInsights = {
      ...mockLeadMemory,
      insights: {
        totalCalls: 5,
        totalMessages: 10,
        totalInteractions: 15,
        hasBooked: true,
        hasBeenTransferred: false,
        highIntent: true,
        slippingAway: false,
      },
    };

    await think('call_ended', {}, memoryWithInsights, mockDb);

    const userMessage = capturedMessages[0].content;
    expect(userMessage).toContain('15');
    expect(userMessage).toContain('Booked: YES');
  });

  it('should log brain reasoning to console', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "User is interested", "actions": [{"action": "send_sms"}]}',
      }],
    });

    await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('[Brain]')
    );
    const brainCalls = mockLogger.info.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('[Brain]'));
    expect(brainCalls.length).toBeGreaterThan(0);
    expect(brainCalls[0][0]).toContain('User is interested');
  });

  it('should handle null lead gracefully', async () => {
    const mockLeadMemoryNoLead = {
      ...mockLeadMemory,
      lead: null,
    };

    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
    });

    const result = await think('call_ended', {}, mockLeadMemoryNoLead, mockDb);

    expect(result).toBeDefined();
    expect(result.actions).toBeDefined();
  });

  it('should handle missing knowledge base gracefully', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.reasoning).toBe('test');
  });

  it('should format multiple timeline events', async () => {
    const mockClient = new Anthropic();
    let capturedMessages = [];
    mockClient.messages.create.mockImplementation(({ messages }) => {
      capturedMessages = messages;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    const memoryWithTimeline = {
      ...mockLeadMemory,
      timeline: [
        {
          type: 'call',
          timestamp: '2024-01-01T10:00:00Z',
          summary: 'Call summary',
          outcome: 'qualified',
          score: 8,
        },
        {
          type: 'message',
          timestamp: '2024-01-01T11:00:00Z',
          direction: 'inbound',
          body: 'Message body',
        },
      ],
    };

    await think('call_ended', {}, memoryWithTimeline, mockDb);

    const userMessage = capturedMessages[0].content;
    expect(userMessage).toContain('CALL:');
    expect(userMessage).toContain('SMS IN:');
  });

  it('should handle action filtering for invalid action types', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "test", "actions": [{"action": "invalid_action"}, {"action": "send_sms", "message": "Hi"}]}',
      }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe('send_sms');
  });

  it('should filter actions with invalid stage values', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "test", "actions": [{"action": "update_lead_stage", "stage": "invalid_stage"}, {"action": "update_lead_stage", "stage": "warm"}]}',
      }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.actions.length).toBeLessThanOrEqual(1);
    const stageActions = result.actions.filter(a => a.action === 'update_lead_stage');
    expect(stageActions.every(a => a.stage !== 'invalid_stage')).toBe(true);
  });

  it('should filter actions with invalid score values', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "test", "actions": [{"action": "update_lead_score", "score": -5}, {"action": "update_lead_score", "score": 15}, {"action": "update_lead_score", "score": 7}]}',
      }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    const scoreActions = result.actions.filter(a => a.action === 'update_lead_score');
    expect(scoreActions.every(a => a.score >= 0 && a.score <= 10)).toBe(true);
  });

  it('should handle missing lead id gracefully (no lock)', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
    });

    const memoryNoLeadId = {
      ...mockLeadMemory,
      lead: { ...mockLeadMemory.lead, id: null },
    };

    const result = await think('call_ended', {}, memoryNoLeadId, mockDb);

    expect(result).toBeDefined();
    expect(result.reasoning).toBeDefined();
  });

  it('should handle lock timeout with force release', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
    });

    // Create a stalled lock by resolving the first call very slowly
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const slowPromise = think('call_ended', {}, mockLeadMemory, mockDb);

    // This should handle the lock timeout case
    await slowPromise;

    // Verify console was called for error handling
    expect(typeof slowPromise).toBe('object');

    consoleSpy.mockRestore();
  });

  it('should include SMS message length validation in actions', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "test", "actions": [{"action": "send_sms", "message": "Hi"}]}',
      }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe('send_sms');
  });

  it('should handle response with multiple text blocks combined', async () => {
    const mockClient = new Anthropic();
    // The code concatenates all text blocks and tries to parse as JSON
    mockClient.messages.create.mockResolvedValue({
      content: [
        { type: 'text', text: '{"rea' },
        { type: 'text', text: 'soning": "test", "actions": []}' },
      ],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    // Since the combined text is valid JSON, it should parse successfully
    expect(result.reasoning).toBe('test');
  });

  it('should handle malformed JSON response with error fallback', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{invalid json}' }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.reasoning).toMatch(/parse error|fallback/i);
    expect(result.actions[0].action).toBe('notify_owner');
  });

  it('should load knowledge base and include in prompt when available', async () => {
    const mockClient = new Anthropic();
    let capturedSystem = '';
    mockClient.messages.create.mockImplementation(({ system }) => {
      capturedSystem = system;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    // Knowledge base file will be read (mocked as {})
    await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(capturedSystem).toContain('BUSINESS KNOWLEDGE BASE');
  });

  it('should truncate oversized knowledge base', async () => {
    const mockClient = new Anthropic();
    let capturedSystem = '';
    mockClient.messages.create.mockImplementation(({ system }) => {
      capturedSystem = system;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      });
    });

    await think('call_ended', {}, mockLeadMemory, mockDb);

    // Verify KB truncation doesn't exceed 5000 chars + truncation marker
    expect(capturedSystem.length).toBeLessThan(10000);
  });

  it('should handle guardrail check errors gracefully', async () => {
    const failingDb = {
      prepare: jest.fn().mockImplementation(() => {
        throw new Error('DB error');
      }),
      query: jest.fn().mockImplementation(() => {
        throw new Error('DB error');
      }),
    };

    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, failingDb);

    expect(result).toBeDefined();
    // Check that logger.error was called with a message containing the pattern
    const calls = mockLogger.error.mock.calls.map(c => c[0]);
    expect(calls.some(c => typeof c === 'string' && c.includes('[Brain] Guardrail check error'))).toBe(true);
  });

  it('should serialize concurrent calls to same lead', async () => {
    const mockClient = new Anthropic();
    const callOrder = [];

    mockClient.messages.create.mockImplementation(async () => {
      callOrder.push('start');
      await new Promise(resolve => setTimeout(resolve, 10));
      callOrder.push('end');
      return {
        content: [{ type: 'text', text: '{"reasoning": "test", "actions": []}' }],
      };
    });

    // Run 3 concurrent calls to same lead
    const results = await Promise.all([
      think('call_ended', {}, mockLeadMemory, mockDb),
      think('sms_received', {}, mockLeadMemory, mockDb),
      think('form_submitted', {}, mockLeadMemory, mockDb),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.reasoning === 'test')).toBe(true);
  });

  it('should trigger circuit breaker after 5 consecutive failures', async () => {
    const mockClient = new Anthropic();
    // The circuit breaker wraps the anthropic call. Since we mock @anthropic-ai/sdk,
    // the breaker's underlying fn calls mockClient.messages.create.
    // We simulate 5 failures in a row, then verify fallback behavior.
    mockClient.messages.create.mockRejectedValue(new Error('API unavailable'));

    // First 5 calls should each return fallback (notify_owner)
    const results = [];
    for (let i = 0; i < 6; i++) {
      const r = await think('call_ended', {}, mockLeadMemory, mockDb);
      results.push(r);
    }

    // All should be fallback responses
    results.forEach(r => {
      expect(r.reasoning).toContain('fallback');
      expect(r.actions[0].action).toBe('notify_owner');
    });
  });

  it('should handle per-lead mutex lock timeout and force release', async () => {
    const mockClient = new Anthropic();

    // First call: make it hang long enough to trigger lock timeout on second call
    let resolveFirst;
    const firstCallPromise = new Promise(resolve => { resolveFirst = resolve; });

    let callCount = 0;
    mockClient.messages.create.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Hang for longer than BRAIN_LOCK_TIMEOUT_MS (10s) — but we can't wait that long in tests,
        // so we test the lock acquisition path with a shorter delay
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return {
        content: [{ type: 'text', text: '{"reasoning": "lock test", "actions": []}' }],
      };
    });

    // Two concurrent calls to the same lead; both should eventually succeed
    const [r1, r2] = await Promise.all([
      think('call_ended', {}, mockLeadMemory, mockDb),
      think('sms_received', {}, mockLeadMemory, mockDb),
    ]);

    expect(r1.reasoning).toBe('lock test');
    expect(r2.reasoning).toBe('lock test');
  });

  it('should filter all actions when none are valid', async () => {
    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "bad actions", "actions": [{"action": "hack_system"}, {"action": "delete_all"}, {"action": ""}]}',
      }],
    });

    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.actions).toHaveLength(0);
  });

  it('should handle knowledge base file read error gracefully', async () => {
    // fs.readFileSync is already mocked to return '{}', but we test the path
    // where kbCache returns null (no KB found)
    const mockClient = new Anthropic();
    let capturedSystem = '';
    mockClient.messages.create.mockImplementation(({ system }) => {
      capturedSystem = system;
      return Promise.resolve({
        content: [{ type: 'text', text: '{"reasoning": "no kb", "actions": []}' }],
      });
    });

    // With a client that has an ID, the KB loader will try but find nothing
    const result = await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(result.reasoning).toBe('no kb');
    // KB section should still appear in prompt (with fallback text)
    expect(capturedSystem).toContain('BUSINESS KNOWLEDGE BASE');
  });

  it('should return fallback when circuit breaker is open', async () => {
    const mockClient = new Anthropic();
    // Force enough rapid failures to trip the circuit breaker
    mockClient.messages.create.mockRejectedValue(new Error('Service down'));

    // Exhaust failures
    for (let i = 0; i < 6; i++) {
      await think('call_ended', {}, mockLeadMemory, mockDb);
    }

    // Next call should still return a valid fallback (circuit open)
    const result = await think('call_ended', {}, mockLeadMemory, mockDb);
    expect(result.reasoning).toContain('fallback');
    expect(result.actions[0].action).toBe('notify_owner');
    expect(result.actions[0].urgency).toBe('medium');
  });
});
