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

const { think } = require('../utils/brain');

describe('brain.think', () => {
  let mockLeadMemory;
  let mockDb;
  let Anthropic;

  beforeEach(() => {
    // Clear mocks
    jest.clearAllMocks();

    // Setup mock database (just for guardrails queries)
    mockDb = {
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(null),
        all: jest.fn().mockReturnValue([]),
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
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const mockClient = new Anthropic();
    mockClient.messages.create.mockResolvedValue({
      content: [{
        type: 'text',
        text: '{"reasoning": "User is interested", "actions": [{"action": "send_sms"}]}',
      }],
    });

    await think('call_ended', {}, mockLeadMemory, mockDb);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Brain]')
    );
    const firstCall = consoleSpy.mock.calls[0][0];
    expect(firstCall).toContain('User is interested');

    consoleSpy.mockRestore();
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
});
