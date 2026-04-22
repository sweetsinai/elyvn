/**
 * Tests for utils/telegram.js
 * Tests Telegram API utilities including webhooks, message sending, and formatting
 */

'use strict';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const { logger } = require('../utils/logger');

describe('telegram utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  describe('sendMessage', () => {
    test('sends message successfully with basic params', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true, message_id: 123 })
      });

      const result = await telegram.sendMessage('12345', 'Hello');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/sendMessage'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
      expect(result.ok).toBe(true);
    });

    test('includes HTML parse mode in message', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      await telegram.sendMessage('12345', 'Hello <b>World</b>');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.parse_mode).toBe('HTML');
    });

    test('disables web page preview', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      await telegram.sendMessage('12345', 'Check this link');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.disable_web_page_preview).toBe(true);
    });

    test('accepts optional parameters', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      const options = { reply_markup: { inline_keyboard: [[{ text: 'Button', callback_data: 'btn' }]] } };
      await telegram.sendMessage('12345', 'Message', options);

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.reply_markup).toBeDefined();
    });

    test('handles API error response', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: jest.fn().mockResolvedValue({ ok: false, error_code: 400 })
      });

      const result = await telegram.sendMessage('12345', 'Test');

      expect(result.ok).toBe(false);
    });

    test('logs error when response is not ok', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: jest.fn().mockResolvedValue({ ok: false, error_code: 401 })
      });

      await telegram.sendMessage('12345', 'Test');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[telegram]'),
        expect.anything()
      );
    });

    test('includes chat_id in request body', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      await telegram.sendMessage('chat-999', 'Test message');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.chat_id).toBe('chat-999');
    });
  });

  describe('answerCallback', () => {
    test('answers callback query successfully', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      const result = await telegram.answerCallback('callback-123', 'Acknowledged!');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/answerCallbackQuery'),
        expect.any(Object)
      );
      expect(result.ok).toBe(true);
    });

    test('includes callback_query_id in request', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      await telegram.answerCallback('cb-456', 'Done');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.callback_query_id).toBe('cb-456');
    });

    test('handles callback with empty text', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      await telegram.answerCallback('cb-789', '');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.text).toBe('');
    });

    test('handles callback API error', async () => {
      const telegram = require('../utils/telegram');

      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: jest.fn().mockResolvedValue({ ok: false, error_code: 400 })
      });

      const result = await telegram.answerCallback('cb-bad', 'Test');

      expect(result.ok).toBe(false);
    });
  });

  describe('setWebhook', () => {
    test('sets webhook without secret', async () => {
      delete process.env.TELEGRAM_WEBHOOK_SECRET;

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      const telegram = require('../utils/telegram');
      const result = await telegram.setWebhook('https://example.com/webhook');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.url).toBe('https://example.com/webhook');
      expect(callBody.secret_token).toBeUndefined();
      expect(result.ok).toBe(true);
    });

    test('sets webhook with secret token', async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'my-secret-123';

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      const telegram = require('../utils/telegram');
      const result = await telegram.setWebhook('https://example.com/webhook');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.url).toBe('https://example.com/webhook');
      expect(callBody.secret_token).toBe('my-secret-123');
    });

    test('logs success message', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ ok: true })
      });

      const telegram = require('../utils/telegram');
      await telegram.setWebhook('https://example.com/webhook');

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[telegram]'),
        expect.anything()
      );
    });

    test('logs failure message when response not ok', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: jest.fn().mockResolvedValue({ ok: false, error: 'Invalid URL' })
      });

      const telegram = require('../utils/telegram');
      await telegram.setWebhook('https://invalid.example.com');

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[telegram]'),
        expect.anything()
      );
    });

    test('handles fetch error', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const telegram = require('../utils/telegram');

      await expect(telegram.setWebhook('https://example.com')).rejects.toThrow();
    });
  });

  describe('formatCallNotification', () => {
    test('formats booked call notification', () => {
      const telegram = require('../utils/telegram');

      const call = {
        call_id: 'call-123',
        outcome: 'booked',
        caller_name: 'John Doe',
        caller_phone: '+1234567890',
        duration: 180,
        score: 90
      };

      const result = telegram.formatCallNotification(call, {});

      expect(result.text).toContain('Call booked');
      expect(result.text).toContain('John Doe');
      expect(result.text).toContain('3m 0s');
      expect(result.text).toContain('90/100');
      expect(result.buttons).toBeDefined();
      expect(result.buttons.length).toBeGreaterThan(0);
    });

    test('formats missed call notification', () => {
      const telegram = require('../utils/telegram');

      const call = {
        call_id: 'call-456',
        outcome: 'missed',
        caller_name: 'Jane Smith',
        duration: 0,
        score: 0
      };

      const result = telegram.formatCallNotification(call, {});

      expect(result.text).toContain('Call missed');
      expect(result.text).toContain('Jane Smith');
    });

    test('formats voicemail notification', () => {
      const telegram = require('../utils/telegram');

      const call = {
        call_id: 'call-789',
        outcome: 'voicemail',
        phone: '+9876543210',
        duration: 0,
        summary: 'Call me back'
      };

      const result = telegram.formatCallNotification(call, {});

      expect(result.text).toContain('voicemail');
      expect(result.text).toContain('Call me back');
    });

    test('uses phone as fallback for caller name', () => {
      const telegram = require('../utils/telegram');

      const call = {
        call_id: 'call-999',
        outcome: 'booked',
        caller_phone: '+1111111111',
        duration: 60,
        score: 7
      };

      const result = telegram.formatCallNotification(call, {});

      expect(result.text).toContain('+1111111111');
    });

    test('shows fire emoji for high score calls', () => {
      const telegram = require('../utils/telegram');

      const call = {
        call_id: 'call-hot',
        outcome: 'booked',
        caller_name: 'Hot Lead',
        duration: 120,
        score: 80
      };

      const result = telegram.formatCallNotification(call, {});

      expect(result.text).toContain('128293'); // Fire emoji HTML code
    });

    test('shows cool emoji for low score calls', () => {
      const telegram = require('../utils/telegram');

      const call = {
        call_id: 'call-cool',
        outcome: 'booked',
        caller_name: 'Lead',
        duration: 30,
        score: 4
      };

      const result = telegram.formatCallNotification(call, {});

      expect(result.text).toContain('129398'); // Cool emoji HTML code
    });

    test('includes transcript button', () => {
      const telegram = require('../utils/telegram');

      const call = {
        call_id: 'call-btn',
        outcome: 'booked',
        caller_name: 'Lead',
        duration: 60,
        score: 7
      };

      const result = telegram.formatCallNotification(call, {});

      expect(result.buttons[0][0].text).toBe('Full transcript');
      expect(result.buttons[0][0].callback_data).toContain('transcript:');
    });
  });

  describe('formatTransferAlert', () => {
    test('formats transfer alert correctly', () => {
      const telegram = require('../utils/telegram');

      const call = {
        caller_name: 'Urgent Client',
        caller_phone: '+1234567890'
      };

      const result = telegram.formatTransferAlert(call, 'Needs live agent', {});

      expect(result.text).toContain('TRANSFER');
      expect(result.text).toContain('Urgent Client');
      expect(result.text).toContain('Needs live agent');
    });

    test('uses phone fallback for caller name', () => {
      const telegram = require('../utils/telegram');

      const call = {
        phone: '+9876543210'
      };

      const result = telegram.formatTransferAlert(call, 'Summary', {});

      expect(result.text).toContain('+9876543210');
    });

    test('handles missing summary', () => {
      const telegram = require('../utils/telegram');

      const call = { caller_name: 'Lead' };

      const result = telegram.formatTransferAlert(call, null, {});

      expect(result.text).toContain('Caller requested transfer');
    });
  });

  describe('formatMessageNotification', () => {
    test('formats message with high confidence', () => {
      const telegram = require('../utils/telegram');

      const message = {
        id: 'msg-1',
        from_name: 'Alice',
        from_phone: '+1234567890',
        body: 'Can you help me?'
      };

      const result = telegram.formatMessageNotification(message, 'Sure!', 'high', {});

      expect(result.text).toContain('New message');
      expect(result.text).toContain('Alice');
      expect(result.text).toContain('Can you help me?');
      expect(result.text).toContain('Sure!');
      expect(result.text).toContain('9989'); // Check mark emoji
    });

    test('formats message with medium confidence', () => {
      const telegram = require('../utils/telegram');

      const message = {
        id: 'msg-2',
        from_name: 'Bob',
        body: 'What time are you open?'
      };

      const result = telegram.formatMessageNotification(message, 'We open at 9am', 'medium', {});

      expect(result.text).toContain('9888'); // Warning emoji
    });

    test('formats message with low confidence', () => {
      const telegram = require('../utils/telegram');

      const message = {
        id: 'msg-3',
        from_name: 'Carol',
        body: 'Complex question here'
      };

      const result = telegram.formatMessageNotification(message, 'Not sure', 'low', {});

      expect(result.text).toContain('10060'); // X emoji
    });

    test('includes action buttons', () => {
      const telegram = require('../utils/telegram');

      const message = {
        id: 'msg-4',
        from_name: 'Dave',
        body: 'Test'
      };

      const result = telegram.formatMessageNotification(message, 'Reply', 'high', {});

      expect(result.buttons).toBeDefined();
      expect(result.buttons[0]).toBeDefined();
      expect(result.buttons[0][0].text).toBe('Good reply');
      expect(result.buttons[0][1].text).toBe("I'll handle this");
    });

    test('includes phone in callback data', () => {
      const telegram = require('../utils/telegram');

      const message = {
        id: 'msg-5',
        from_name: 'Eve',
        from_phone: '+5555555555',
        body: 'Test'
      };

      const result = telegram.formatMessageNotification(message, 'OK', 'high', {});

      expect(result.buttons[0][1].callback_data).toContain('+5555555555');
    });
  });

  describe('formatEscalation', () => {
    test('formats escalation notification', () => {
      const telegram = require('../utils/telegram');

      const message = {
        from_name: 'Support Case',
        from_phone: '+1234567890',
        body: 'Need your expertise'
      };

      const result = telegram.formatEscalation(message, 'Draft reply', {});

      expect(result.text).toContain('Needs your input');
      expect(result.text).toContain('Support Case');
      expect(result.text).toContain('Need your expertise');
      expect(result.text).toContain('Draft reply');
    });

    test('handles missing AI reply', () => {
      const telegram = require('../utils/telegram');

      const message = {
        from_name: 'Case',
        body: 'Help'
      };

      const result = telegram.formatEscalation(message, null, {});

      expect(result.text).toContain('None');
    });
  });

  describe('formatBookingNotification', () => {
    test('formats booking notification', () => {
      const telegram = require('../utils/telegram');

      const booking = {
        customer_name: 'John Smith',
        service: 'Haircut',
        datetime: '2024-03-28 14:00',
        location: 'Downtown',
        estimated_revenue: 45
      };

      const result = telegram.formatBookingNotification(booking, {});

      expect(result.text).toContain('New booking');
      expect(result.text).toContain('John Smith');
      expect(result.text).toContain('Haircut');
      expect(result.text).toContain('Downtown');
      expect(result.text).toContain('45');
    });

    test('uses fallback values for missing fields', () => {
      const telegram = require('../utils/telegram');

      const booking = {
        name: 'Fallback Name',
        service: 'Service'
      };

      const result = telegram.formatBookingNotification(booking, {});

      expect(result.text).toContain('Fallback Name');
      expect(result.text).toContain('Service');
      expect(result.text).toContain('Default');
    });
  });

  describe('formatDailySummary', () => {
    test('formats daily summary with stats', () => {
      const telegram = require('../utils/telegram');

      const stats = {
        total_calls: 10,
        booked: 3,
        missed: 2,
        messages: 5,
        revenue: 500
      };

      const result = telegram.formatDailySummary(stats, [], {});

      expect(result.text).toContain('Daily Summary');
      expect(result.text).toContain('10');
      expect(result.text).toContain('Booked');
      expect(result.text).toContain('Missed');
      expect(result.text).toContain('500');
    });

    test('includes tomorrow schedule when available', () => {
      const telegram = require('../utils/telegram');

      const stats = {
        total_calls: 5,
        booked: 2,
        missed: 1,
        messages: 3,
        revenue: 300
      };

      const tomorrow = [
        { time: '09:00', customer_name: 'Client A', service: 'Consultation' },
        { time: '14:00', customer_name: 'Client B', service: 'Check-up' }
      ];

      const result = telegram.formatDailySummary(stats, tomorrow, {});

      expect(result.text).toContain("Tomorrow's schedule");
      expect(result.text).toContain('Client A');
      expect(result.text).toContain('Client B');
    });

    test('shows no appointments message when tomorrow empty', () => {
      const telegram = require('../utils/telegram');

      const stats = { total_calls: 0, booked: 0, missed: 0, messages: 0, revenue: 0 };

      const result = telegram.formatDailySummary(stats, [], {});

      expect(result.text).toContain('No appointments tomorrow');
    });
  });

  describe('formatWeeklyReport', () => {
    test('formats weekly report', () => {
      const telegram = require('../utils/telegram');

      const report = {
        total_calls: 50,
        booked: 15,
        missed: 5,
        messages: 25,
        revenue: 3000,
        missed_rate: 10,
        ai_summary: 'Great week overall'
      };

      const result = telegram.formatWeeklyReport(report, {});

      expect(result.text).toContain('Weekly Report');
      expect(result.text).toContain('50');
      expect(result.text).toContain('Great week overall');
      expect(result.text).toContain('10%');
    });

    test('handles missing AI summary', () => {
      const telegram = require('../utils/telegram');

      const report = {
        total_calls: 30,
        booked: 10,
        missed: 3,
        messages: 15,
        revenue: 2000,
        missed_rate: 10
      };

      const result = telegram.formatWeeklyReport(report, {});

      expect(result.text).toContain('No summary available');
    });
  });

  describe('module exports', () => {
    test('exports all required functions', () => {
      const telegram = require('../utils/telegram');

      expect(typeof telegram.sendMessage).toBe('function');
      expect(typeof telegram.answerCallback).toBe('function');
      expect(typeof telegram.setWebhook).toBe('function');
      expect(typeof telegram.formatCallNotification).toBe('function');
      expect(typeof telegram.formatTransferAlert).toBe('function');
      expect(typeof telegram.formatMessageNotification).toBe('function');
      expect(typeof telegram.formatEscalation).toBe('function');
      expect(typeof telegram.formatBookingNotification).toBe('function');
      expect(typeof telegram.formatDailySummary).toBe('function');
      expect(typeof telegram.formatWeeklyReport).toBe('function');
    });
  });
});
