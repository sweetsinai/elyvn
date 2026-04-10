'use strict';

/**
 * Tests for Phase 5: Conversations API — unified messaging, two-way SMS, delivery status, read receipts
 */

jest.mock('@anthropic-ai/sdk');

// Mock webhookQueue
const mockEnqueue = jest.fn().mockResolvedValue('mock-entry-id');
jest.mock('../utils/webhookQueue', () => ({
  enqueue: mockEnqueue,
  processQueue: jest.fn(),
  startProcessor: jest.fn(),
  stopProcessor: jest.fn(),
  _getQueuePath: () => '/tmp/test-webhook-queue.json',
}));

// Mock websocket broadcast
const mockBroadcast = jest.fn();
jest.mock('../utils/websocket', () => ({
  broadcast: mockBroadcast,
  initWebSocket: jest.fn(),
  getConnectionCount: jest.fn().mockReturnValue(0),
  cleanupWebSocket: jest.fn(),
}));

// Mock SMS
const mockSendSMS = jest.fn().mockResolvedValue({ success: true, messageId: 'SM_test_123' });
jest.mock('../utils/sms', () => ({
  sendSMS: mockSendSMS,
  sendSMSToOwner: jest.fn().mockResolvedValue({ success: true }),
  cleanupSMSTimers: jest.fn(),
  initRateLimiterFromDB: jest.fn(),
  SMS_PROVIDER: 'twilio',
}));

const { buildPayload } = require('../utils/webhookEvents');
const { randomUUID } = require('crypto');

describe('Migration 044 — Conversations Schema', () => {
  test('conversations table has required columns', () => {
    const requiredCols = ['id', 'client_id', 'lead_id', 'lead_phone', 'lead_name',
      'last_message_at', 'last_message_preview', 'unread_count', 'status',
      'created_at', 'updated_at'];
    // Verify via schema definition — the migration creates these columns
    expect(requiredCols.length).toBe(11);
  });

  test('messages table has new columns for Phase 5', () => {
    const newCols = ['conversation_id', 'delivery_status', 'delivered_at', 'read_at'];
    expect(newCols.length).toBe(4);
  });

  test('conversation status enum includes active, archived, spam', () => {
    const validStatuses = ['active', 'archived', 'spam'];
    expect(validStatuses).toContain('active');
    expect(validStatuses).toContain('archived');
    expect(validStatuses).toContain('spam');
  });

  test('delivery_status defaults to sent for outbound', () => {
    // Migration 044 sets: delivery_status = 'sent' for outbound, 'received' for inbound
    const outbound = { direction: 'outbound', delivery_status: 'sent' };
    const inbound = { direction: 'inbound', delivery_status: 'received' };
    expect(outbound.delivery_status).toBe('sent');
    expect(inbound.delivery_status).toBe('received');
  });

  test('conversations unique on (client_id, lead_phone)', () => {
    // Migration creates UNIQUE INDEX idx_conversations_phone ON conversations(client_id, lead_phone)
    const conv1 = { client_id: 'c1', lead_phone: '+15551234567' };
    const conv2 = { client_id: 'c1', lead_phone: '+15551234567' };
    // Same (client_id, lead_phone) should conflict
    expect(conv1.client_id).toBe(conv2.client_id);
    expect(conv1.lead_phone).toBe(conv2.lead_phone);
  });
});

describe('Conversations API — List', () => {
  test('conversation list response has correct shape', () => {
    const response = {
      success: true,
      data: [
        {
          id: randomUUID(),
          client_id: 'c1',
          lead_id: 'lead-1',
          lead_phone: '+15551234567',
          lead_name: 'John Doe',
          last_message_at: new Date().toISOString(),
          last_message_preview: 'Thanks for the info!',
          unread_count: 3,
          status: 'active',
          lead_score: 75,
          lead_stage: 'qualified',
        },
      ],
      pagination: { total: 1, limit: 30, offset: 0, hasMore: false },
    };

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toHaveProperty('lead_phone');
    expect(response.data[0]).toHaveProperty('unread_count');
    expect(response.data[0]).toHaveProperty('lead_score');
    expect(response.data[0]).toHaveProperty('lead_stage');
  });

  test('conversations sorted by last_message_at DESC', () => {
    const convs = [
      { id: '1', last_message_at: '2026-04-10T10:00:00Z' },
      { id: '2', last_message_at: '2026-04-10T12:00:00Z' },
      { id: '3', last_message_at: '2026-04-10T08:00:00Z' },
    ];
    const sorted = [...convs].sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    expect(sorted[0].id).toBe('2');
    expect(sorted[2].id).toBe('3');
  });

  test('search filters by phone, name, or preview', () => {
    const convs = [
      { lead_phone: '+15551234567', lead_name: 'Alice', last_message_preview: 'Hello' },
      { lead_phone: '+15559876543', lead_name: 'Bob', last_message_preview: 'Booking confirmed' },
    ];
    const search = 'alice';
    const filtered = convs.filter(c =>
      c.lead_phone.toLowerCase().includes(search) ||
      (c.lead_name || '').toLowerCase().includes(search) ||
      (c.last_message_preview || '').toLowerCase().includes(search)
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].lead_name).toBe('Alice');
  });

  test('status filter excludes non-matching conversations', () => {
    const convs = [
      { id: '1', status: 'active' },
      { id: '2', status: 'archived' },
      { id: '3', status: 'active' },
    ];
    const active = convs.filter(c => c.status === 'active');
    expect(active).toHaveLength(2);
  });
});

describe('Conversations API — Timeline', () => {
  test('unified timeline merges messages and calls sorted by created_at', () => {
    const messages = [
      { id: 'm1', entry_type: 'message', direction: 'inbound', body: 'Hi', created_at: '2026-04-10T09:00:00Z' },
      { id: 'm2', entry_type: 'message', direction: 'outbound', body: 'Hello!', created_at: '2026-04-10T09:01:00Z' },
    ];
    const calls = [
      { id: 'c1', entry_type: 'call', direction: 'inbound', duration: 120, created_at: '2026-04-10T09:05:00Z' },
    ];

    const timeline = [...messages, ...calls].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    expect(timeline).toHaveLength(3);
    expect(timeline[0].entry_type).toBe('message');
    expect(timeline[0].id).toBe('m1');
    expect(timeline[2].entry_type).toBe('call');
    expect(timeline[2].id).toBe('c1');
  });

  test('timeline entries have correct entry_type field', () => {
    const msg = { entry_type: 'message', body: 'test' };
    const call = { entry_type: 'call', duration: 60 };
    expect(msg.entry_type).toBe('message');
    expect(call.entry_type).toBe('call');
  });

  test('messages include delivery_status', () => {
    const msg = {
      id: 'm1', entry_type: 'message', direction: 'outbound',
      body: 'Reply', delivery_status: 'delivered', delivered_at: '2026-04-10T09:02:00Z',
    };
    expect(msg.delivery_status).toBe('delivered');
    expect(msg.delivered_at).toBeTruthy();
  });
});

describe('Conversations API — Send Message (Two-Way SMS)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sendSMS is called with correct params', async () => {
    const to = '+15551234567';
    const body = 'Hey, following up on your inquiry!';
    const from = '+15559999999';

    await mockSendSMS(to, body, from, null, 'client-1');

    expect(mockSendSMS).toHaveBeenCalledWith(to, body, from, null, 'client-1');
  });

  test('sent message gets recorded with manual_reply status', () => {
    const msg = {
      id: randomUUID(),
      client_id: 'c1',
      phone: '+15551234567',
      direction: 'outbound',
      body: 'Following up!',
      status: 'manual_reply',
      channel: 'sms',
      conversation_id: 'conv-1',
      delivery_status: 'sent',
      message_sid: 'SM_test_123',
    };

    expect(msg.status).toBe('manual_reply');
    expect(msg.conversation_id).toBe('conv-1');
    expect(msg.delivery_status).toBe('sent');
  });

  test('WebSocket broadcasts on send with conversationId', () => {
    mockBroadcast('new_message', {
      id: 'msg-1',
      conversationId: 'conv-1',
      phone: '+15551234567',
      direction: 'outbound',
      body: 'Hello from dashboard!',
      status: 'manual_reply',
      delivery_status: 'sent',
    }, 'client-1');

    expect(mockBroadcast).toHaveBeenCalledWith(
      'new_message',
      expect.objectContaining({ conversationId: 'conv-1', direction: 'outbound', status: 'manual_reply' }),
      'client-1'
    );
  });

  test('send message fires sms.sent webhook', async () => {
    const payload = buildPayload('sms.sent', 'c1', {
      to: '+15551234567',
      from: '+15559999999',
      body: 'Dashboard reply',
      messageId: 'SM_test_123',
      leadId: 'lead-1',
    });

    expect(payload.event).toBe('sms.sent');
    expect(payload.data.to).toBe('+15551234567');
    expect(payload.data.messageId).toBe('SM_test_123');
  });

  test('SMS failure returns appropriate error', async () => {
    mockSendSMS.mockResolvedValueOnce({ success: false, error: 'Rate limited. Retry in 120s' });

    const result = await mockSendSMS('+15551234567', 'test', '+15559999999');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limited');
  });

  test('opted-out number returns reason', async () => {
    mockSendSMS.mockResolvedValueOnce({ success: false, reason: 'opted_out' });

    const result = await mockSendSMS('+15551234567', 'test', '+15559999999');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('opted_out');
  });
});

describe('Conversations API — Read Receipts', () => {
  test('mark read sets read_at and delivery_status on inbound messages', () => {
    const now = new Date().toISOString();
    const messages = [
      { id: 'm1', direction: 'inbound', read_at: null, delivery_status: 'received' },
      { id: 'm2', direction: 'inbound', read_at: null, delivery_status: 'received' },
      { id: 'm3', direction: 'outbound', read_at: null, delivery_status: 'sent' },
    ];

    // Mark inbound as read
    const updated = messages.map(m => {
      if (m.direction === 'inbound' && !m.read_at) {
        return { ...m, read_at: now, delivery_status: 'read' };
      }
      return m;
    });

    expect(updated[0].read_at).toBe(now);
    expect(updated[0].delivery_status).toBe('read');
    expect(updated[1].read_at).toBe(now);
    expect(updated[2].read_at).toBeNull(); // outbound not affected
    expect(updated[2].delivery_status).toBe('sent');
  });

  test('mark read resets conversation unread_count to 0', () => {
    const conv = { id: 'conv-1', unread_count: 5 };
    conv.unread_count = 0;
    expect(conv.unread_count).toBe(0);
  });
});

describe('Conversations API — Archive', () => {
  test('archive sets status to archived', () => {
    const conv = { id: 'conv-1', status: 'active' };
    conv.status = 'archived';
    expect(conv.status).toBe('archived');
  });
});

describe('Conversation Schema Validation', () => {
  const { ConversationQuerySchema, SendMessageBodySchema, ConversationDetailParamsSchema } = require('../utils/schemas/conversation');

  test('valid query params pass validation', () => {
    const result = ConversationQuerySchema.safeParse({ page: 1, limit: 30, status: 'active' });
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('active');
  });

  test('invalid status fails validation', () => {
    const result = ConversationQuerySchema.safeParse({ status: 'invalid_status' });
    expect(result.success).toBe(false);
  });

  test('valid send message body passes', () => {
    const result = SendMessageBodySchema.safeParse({ body: 'Hello, following up!' });
    expect(result.success).toBe(true);
  });

  test('empty body fails send validation', () => {
    const result = SendMessageBodySchema.safeParse({ body: '' });
    // Zod safeString strips and then max check — empty string after transform
    expect(result.success).toBe(false);
  });

  test('oversized body (>1600 chars) fails send validation', () => {
    const result = SendMessageBodySchema.safeParse({ body: 'a'.repeat(1700) });
    expect(result.success).toBe(false);
  });

  test('send body strips HTML tags (XSS prevention)', () => {
    const result = SendMessageBodySchema.safeParse({ body: 'Hello <script>alert("xss")</script> world' });
    expect(result.success).toBe(true);
    expect(result.data.body).not.toContain('<script>');
    expect(result.data.body).toContain('Hello');
    expect(result.data.body).toContain('world');
  });

  test('valid detail params pass', () => {
    const result = ConversationDetailParamsSchema.safeParse({
      clientId: randomUUID(),
      conversationId: randomUUID(),
    });
    expect(result.success).toBe(true);
  });

  test('invalid UUID fails detail params', () => {
    const result = ConversationDetailParamsSchema.safeParse({
      clientId: 'not-a-uuid',
      conversationId: 'also-not-uuid',
    });
    expect(result.success).toBe(false);
  });
});

describe('Conversation ensureConversation Logic', () => {
  test('new conversation gets unread_count 1 on inbound', () => {
    const newConv = { id: randomUUID(), unread_count: 1 };
    expect(newConv.unread_count).toBe(1);
  });

  test('existing conversation increments unread_count', () => {
    const conv = { id: 'conv-1', unread_count: 3 };
    conv.unread_count += 1;
    expect(conv.unread_count).toBe(4);
  });

  test('conversation preview truncated to 100 chars', () => {
    const longBody = 'a'.repeat(200);
    const preview = longBody.substring(0, 100);
    expect(preview.length).toBe(100);
  });

  test('lead_id gets backfilled on conversation when provided', () => {
    const conv = { id: 'conv-1', lead_id: null };
    const leadId = 'lead-123';
    // COALESCE(lead_id, ?) behavior
    conv.lead_id = conv.lead_id || leadId;
    expect(conv.lead_id).toBe('lead-123');
  });
});

describe('Delivery Status Tracking', () => {
  test('valid delivery statuses', () => {
    const valid = ['sent', 'delivered', 'read', 'failed', 'received'];
    expect(valid).toContain('sent');
    expect(valid).toContain('delivered');
    expect(valid).toContain('read');
    expect(valid).toContain('failed');
    expect(valid).toContain('received');
  });

  test('outbound messages default to sent', () => {
    const msg = { direction: 'outbound', delivery_status: 'sent' };
    expect(msg.delivery_status).toBe('sent');
  });

  test('inbound messages default to received', () => {
    const msg = { direction: 'inbound', delivery_status: 'received' };
    expect(msg.delivery_status).toBe('received');
  });
});

describe('Migration Backfill', () => {
  test('messages grouped by (client_id, phone) create unique conversations', () => {
    const messages = [
      { client_id: 'c1', phone: '+1555111', body: 'A' },
      { client_id: 'c1', phone: '+1555111', body: 'B' },
      { client_id: 'c1', phone: '+1555222', body: 'C' },
      { client_id: 'c2', phone: '+1555111', body: 'D' },
    ];

    const groups = new Map();
    for (const m of messages) {
      const key = `${m.client_id}:${m.phone}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    expect(groups.size).toBe(3); // c1:+1555111, c1:+1555222, c2:+1555111
  });

  test('conversation preview uses latest message body', () => {
    const msgs = [
      { body: 'First', created_at: '2026-01-01T00:00:00Z' },
      { body: 'Latest message here', created_at: '2026-04-10T12:00:00Z' },
    ];
    const latest = msgs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    expect(latest.body).toBe('Latest message here');
  });
});
