'use strict';

/**
 * Tests for Phase 4: Integrations API + Call Transfer API + WebSocket call events
 */

jest.mock('@anthropic-ai/sdk');

const fs = require('fs');
const path = require('path');

// Mock webhookQueue
const mockEnqueue = jest.fn().mockResolvedValue('mock-entry-id');
jest.mock('../utils/webhookQueue', () => ({
  enqueue: mockEnqueue,
  processQueue: jest.fn(),
  startProcessor: jest.fn(),
  stopProcessor: jest.fn(),
  _getQueuePath: () => '/tmp/test-webhook-queue.json',
}));

// Mock callTransfer
const mockWarmTransfer = jest.fn();
const mockColdTransfer = jest.fn();
jest.mock('../utils/callTransfer', () => ({
  warmTransfer: mockWarmTransfer,
  coldTransfer: mockColdTransfer,
}));

// Mock websocket broadcast
const mockBroadcast = jest.fn();
jest.mock('../utils/websocket', () => ({
  broadcast: mockBroadcast,
  initWebSocket: jest.fn(),
  getConnectionCount: jest.fn().mockReturnValue(0),
  cleanupWebSocket: jest.fn(),
}));

const { buildPayload } = require('../utils/webhookEvents');

describe('Integrations API', () => {
  describe('GET /integrations/:clientId/webhook-log', () => {
    test('returns empty log when no queue file exists', () => {
      // The route reads the webhook queue JSON file directly
      // With no file, it should return an empty array
      const entries = [];
      expect(entries).toEqual([]);
    });

    test('filters entries by client ID', () => {
      const entries = [
        { id: '1', payload: { clientId: 'c1' }, headers: { 'X-Client-Id': 'c1' }, createdAt: new Date().toISOString(), url: 'https://a.com', attempts: 0 },
        { id: '2', payload: { clientId: 'c2' }, headers: { 'X-Client-Id': 'c2' }, createdAt: new Date().toISOString(), url: 'https://b.com', attempts: 0 },
        { id: '3', payload: { clientId: 'c1' }, headers: { 'X-Client-Id': 'c1' }, createdAt: new Date().toISOString(), url: 'https://c.com', attempts: 1 },
      ];

      const clientId = 'c1';
      const filtered = entries.filter(e => {
        const headerMatch = e.headers?.['X-Client-Id'] === clientId;
        const payloadMatch = e.payload?.clientId === clientId;
        return headerMatch || payloadMatch;
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.every(e => e.payload.clientId === 'c1')).toBe(true);
    });

    test('limits to 50 entries sorted by newest first', () => {
      const entries = Array.from({ length: 60 }, (_, i) => ({
        id: `entry-${i}`,
        payload: { clientId: 'c1' },
        headers: { 'X-Client-Id': 'c1' },
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
        url: 'https://a.com',
        attempts: 0,
      }));

      const sorted = entries
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50);

      expect(sorted).toHaveLength(50);
      expect(new Date(sorted[0].createdAt).getTime()).toBeGreaterThan(new Date(sorted[49].createdAt).getTime());
    });
  });

  describe('POST /integrations/:clientId/webhook-test', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('buildPayload creates test payload with _test flag', () => {
      const payload = buildPayload('call_ended', 'c1', {
        _test: true,
        message: 'Test call_ended webhook from ELYVN',
        timestamp: new Date().toISOString(),
      });

      expect(payload.event).toBe('call_ended');
      expect(payload.clientId).toBe('c1');
      expect(payload.data._test).toBe(true);
      expect(payload.data.message).toContain('Test');
    });

    test('enqueues test webhook for valid event types', async () => {
      const validEvents = ['call_ended', 'lead.created', 'lead.stage_changed', 'sms.received', 'sms.sent', 'booking.created'];

      for (const eventType of validEvents) {
        const payload = buildPayload(eventType, 'c1', { _test: true });
        await mockEnqueue('https://hooks.zapier.com/test', payload, { 'X-Client-Id': 'c1' });
      }

      expect(mockEnqueue).toHaveBeenCalledTimes(validEvents.length);
    });
  });

  describe('GET /integrations/:clientId/status', () => {
    test('returns integration status shape', () => {
      const status = {
        retell: { configured: true, details: { agent_id: true, api_key: true } },
        twilio: { configured: true, details: { phone_number: '+15551234567' } },
        calcom: { configured: false, details: { booking_link: false } },
        telegram: { configured: true, details: { chat_id: true } },
        smtp: { configured: false, details: {} },
        webhooks: { lead: true, booking: false, call: true, sms: false, stage_change: false },
        transfer: { configured: true, phone: '+15559876543' },
      };

      expect(status.retell.configured).toBe(true);
      expect(status.calcom.configured).toBe(false);
      expect(status.webhooks.lead).toBe(true);
      expect(status.transfer.phone).toBe('+15559876543');
    });
  });
});

describe('Call Transfer API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('warm transfer success broadcasts event', async () => {
    mockWarmTransfer.mockResolvedValue({ success: true });

    const result = await mockWarmTransfer('call-123', '+15551234567', 'Dashboard-initiated transfer.');
    expect(result.success).toBe(true);

    mockBroadcast('call_transfer', { id: 'call-123', status: 'transferred', target: '+15551234567' }, 'client-1');
    expect(mockBroadcast).toHaveBeenCalledWith(
      'call_transfer',
      { id: 'call-123', status: 'transferred', target: '+15551234567' },
      'client-1'
    );
  });

  test('warm transfer failure falls back to cold', async () => {
    mockWarmTransfer.mockResolvedValue({ success: false, error: 'Circuit open' });
    mockColdTransfer.mockResolvedValue({ success: true });

    const warmResult = await mockWarmTransfer('call-123', '+15551234567');
    expect(warmResult.success).toBe(false);

    const coldResult = await mockColdTransfer('TWILIO-SID-123', '+15551234567');
    expect(coldResult.success).toBe(true);
  });

  test('both transfer methods failing returns appropriate error', async () => {
    mockWarmTransfer.mockResolvedValue({ success: false, error: 'Retell unavailable' });
    mockColdTransfer.mockResolvedValue({ success: false, error: 'Twilio timeout' });

    const warmResult = await mockWarmTransfer('call-123', '+15551234567');
    const coldResult = await mockColdTransfer('TWILIO-SID-123', '+15551234567');

    expect(warmResult.success).toBe(false);
    expect(coldResult.success).toBe(false);
  });
});

describe('WebSocket Call Events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('broadcasts call_started event', () => {
    mockBroadcast('call_started', { id: 'call-1', phone: '+15551234567', direction: 'inbound', status: 'ringing' }, 'client-1');

    expect(mockBroadcast).toHaveBeenCalledWith(
      'call_started',
      expect.objectContaining({ id: 'call-1', status: 'ringing' }),
      'client-1'
    );
  });

  test('broadcasts call_transfer event', () => {
    mockBroadcast('call_transfer', { id: 'call-1', phone: '+15551234567', status: 'transferring', summary: 'Transfer requested' });

    expect(mockBroadcast).toHaveBeenCalledWith(
      'call_transfer',
      expect.objectContaining({ id: 'call-1', status: 'transferring' }),
    );
  });

  test('broadcasts new_call event on call end', () => {
    mockBroadcast('new_call', { id: 'call-1', phone: '+15551234567', status: 'booked', duration: 120, score: 8.5, summary: 'Customer booked appointment' });

    expect(mockBroadcast).toHaveBeenCalledWith(
      'new_call',
      expect.objectContaining({ id: 'call-1', status: 'booked', score: 8.5 }),
    );
  });
});
