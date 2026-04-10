'use strict';

/**
 * Tests for Phase 3: Webhook Events
 *
 * Covers: webhookEvents.js helpers, webhook URL in settings API,
 *         and sheets export endpoint.
 */

jest.mock('@anthropic-ai/sdk');

const fs = require('fs');
const path = require('path');

// Mock webhookQueue before requiring webhookEvents
const mockEnqueue = jest.fn().mockResolvedValue('mock-id');
jest.mock('../utils/webhookQueue', () => ({
  enqueue: mockEnqueue,
  processQueue: jest.fn(),
  startProcessor: jest.fn(),
  stopProcessor: jest.fn(),
  _getQueuePath: () => '/tmp/test-webhook-queue.json',
}));

const { fireCallEnded, fireLeadStageChanged, fireSmsReceived, fireSmsSent, buildPayload } = require('../utils/webhookEvents');

describe('Webhook Events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildPayload', () => {
    test('creates standardized event payload', () => {
      const payload = buildPayload('call_ended', 'client-123', { callId: 'call-1' });
      expect(payload.event).toBe('call_ended');
      expect(payload.clientId).toBe('client-123');
      expect(payload.timestamp).toBeDefined();
      expect(payload.data.callId).toBe('call-1');
    });

    test('includes ISO 8601 timestamp', () => {
      const payload = buildPayload('test', 'c1', {});
      expect(() => new Date(payload.timestamp)).not.toThrow();
      expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
    });
  });

  describe('fireCallEnded', () => {
    test('enqueues webhook when call_webhook_url is set', async () => {
      const client = { id: 'c1', call_webhook_url: 'https://example.com/hook' };
      await fireCallEnded(client, {
        callId: 'call-1', phone: '+15551234567', duration: 120,
        outcome: 'booked', score: 85, summary: 'Good call', sentiment: 'positive',
      });

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const [url, payload, headers] = mockEnqueue.mock.calls[0];
      expect(url).toBe('https://example.com/hook');
      expect(payload.event).toBe('call_ended');
      expect(payload.clientId).toBe('c1');
      expect(payload.data.callId).toBe('call-1');
      expect(payload.data.outcome).toBe('booked');
      expect(headers['X-Client-Id']).toBe('c1');
    });

    test('skips when call_webhook_url is not set', async () => {
      await fireCallEnded({ id: 'c1' }, { callId: 'call-1' });
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test('does not throw on enqueue error', async () => {
      mockEnqueue.mockRejectedValueOnce(new Error('queue full'));
      const client = { id: 'c1', call_webhook_url: 'https://example.com/hook' };
      await expect(fireCallEnded(client, { callId: 'call-1' })).resolves.not.toThrow();
    });
  });

  describe('fireLeadStageChanged', () => {
    test('enqueues webhook with old and new stage', async () => {
      const client = { id: 'c1', stage_change_webhook_url: 'https://example.com/stage' };
      await fireLeadStageChanged(client, {
        leadId: 'lead-1', oldStage: 'new', newStage: 'contacted',
        leadData: { name: 'John', phone: '+15551234567' },
      });

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const [url, payload] = mockEnqueue.mock.calls[0];
      expect(url).toBe('https://example.com/stage');
      expect(payload.event).toBe('lead.stage_changed');
      expect(payload.data.oldStage).toBe('new');
      expect(payload.data.newStage).toBe('contacted');
      expect(payload.data.name).toBe('John');
    });

    test('skips when stage_change_webhook_url is not set', async () => {
      await fireLeadStageChanged({ id: 'c1' }, { leadId: 'l1', oldStage: 'a', newStage: 'b', leadData: {} });
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  describe('fireSmsReceived', () => {
    test('enqueues webhook on inbound SMS', async () => {
      const client = { id: 'c1', sms_webhook_url: 'https://example.com/sms' };
      await fireSmsReceived(client, { from: '+15551234567', to: '+15559876543', body: 'Hello', messageId: 'msg-1', leadId: 'lead-1' });

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const [, payload] = mockEnqueue.mock.calls[0];
      expect(payload.event).toBe('sms.received');
      expect(payload.data.from).toBe('+15551234567');
      expect(payload.data.body).toBe('Hello');
    });

    test('skips when sms_webhook_url is not set', async () => {
      await fireSmsReceived({ id: 'c1' }, { from: '+1', to: '+2', body: 'Hi' });
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  describe('fireSmsSent', () => {
    test('enqueues webhook on outbound SMS', async () => {
      const client = { id: 'c1', sms_webhook_url: 'https://example.com/sms' };
      await fireSmsSent(client, { to: '+15551234567', from: '+15559876543', body: 'Reply', messageId: 'msg-2', leadId: 'lead-1' });

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const [, payload] = mockEnqueue.mock.calls[0];
      expect(payload.event).toBe('sms.sent');
      expect(payload.data.to).toBe('+15551234567');
    });

    test('skips when sms_webhook_url is not set', async () => {
      await fireSmsSent({ id: 'c1' }, { to: '+1', from: '+2', body: 'Hi' });
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });
});

describe('Webhook URL Settings', () => {
  const WEBHOOK_FIELDS = [
    'lead_webhook_url',
    'booking_webhook_url',
    'call_webhook_url',
    'sms_webhook_url',
    'stage_change_webhook_url',
  ];

  test('all webhook fields are in the settings ALLOWED set', () => {
    // Read the settings source to verify ALLOWED contains webhook fields
    const settingsSource = fs.readFileSync(
      path.join(__dirname, '../routes/api/settings.js'), 'utf8'
    );
    for (const field of WEBHOOK_FIELDS) {
      expect(settingsSource).toContain(`'${field}'`);
    }
  });

  test('settings GET response includes webhooks category', () => {
    const settingsSource = fs.readFileSync(
      path.join(__dirname, '../routes/api/settings.js'), 'utf8'
    );
    expect(settingsSource).toContain('webhooks:');
    for (const field of WEBHOOK_FIELDS) {
      expect(settingsSource).toContain(`${field}:`);
    }
  });
});

describe('Migration 043', () => {
  test('migration 043 exists and adds webhook columns', () => {
    const { migrations } = require('../utils/migrations');
    const m043 = migrations.find(m => m.id === '043_webhook_event_columns');
    expect(m043).toBeDefined();
    expect(m043.description).toContain('webhook');
    expect(typeof m043.up).toBe('function');
    expect(typeof m043.down).toBe('function');
  });

  test('migration 043 up() adds columns safely (idempotent)', () => {
    const { migrations } = require('../utils/migrations');
    const m043 = migrations.find(m => m.id === '043_webhook_event_columns');

    // Mock SQLite db — simulate a DB that already has booking_webhook_url from migration 038
    const existingCols = [
      { name: 'id' }, { name: 'business_name' }, { name: 'booking_webhook_url' },
    ];
    const execCalls = [];
    const mockDb = {
      prepare: jest.fn().mockReturnValue({
        all: jest.fn().mockReturnValue(existingCols),
      }),
      exec: jest.fn((sql) => execCalls.push(sql)),
    };

    m043.up(mockDb);

    // Should add all 4 new columns (lead, call, sms, stage_change)
    const addedCols = execCalls.filter(s => s.includes('ALTER TABLE'));
    expect(addedCols.length).toBe(4);
    expect(addedCols.some(s => s.includes('lead_webhook_url'))).toBe(true);
    expect(addedCols.some(s => s.includes('call_webhook_url'))).toBe(true);
    expect(addedCols.some(s => s.includes('sms_webhook_url'))).toBe(true);
    expect(addedCols.some(s => s.includes('stage_change_webhook_url'))).toBe(true);
  });
});

describe('Sheets Export', () => {
  test('exports route file contains /sheets endpoint', () => {
    const exportsSource = fs.readFileSync(
      path.join(__dirname, '../routes/api/exports.js'), 'utf8'
    );
    expect(exportsSource).toContain("'/exports/:clientId/sheets'");
    expect(exportsSource).toContain('# Leads');
    expect(exportsSource).toContain('# Calls');
    expect(exportsSource).toContain('# Messages');
  });

  test('sheets endpoint supports JSON format', () => {
    const exportsSource = fs.readFileSync(
      path.join(__dirname, '../routes/api/exports.js'), 'utf8'
    );
    expect(exportsSource).toContain("format === 'json'");
    expect(exportsSource).toContain('leads:');
    expect(exportsSource).toContain('calls:');
    expect(exportsSource).toContain('messages:');
  });
});
