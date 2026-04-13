'use strict';

/**
 * Tests for Phase 2: Call Transfer
 *
 * Covers: warmTransfer, coldTransfer, handleTransfer cascade,
 *         fallback to voicemail + Telegram notification.
 */

jest.mock('@anthropic-ai/sdk');

const originalFetch = global.fetch;

describe('Call Transfer', () => {
  let mockFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    process.env.RETELL_API_KEY = 'test-retell-key';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest123456789';
    process.env.TWILIO_AUTH_TOKEN = 'test-twilio-auth-token-for-ci';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetModules();
  });

  afterAll(() => {
    delete process.env.RETELL_API_KEY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  describe('warmTransfer', () => {
    test('sends POST to Retell transfer-call endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'transferred' }),
      });

      const { warmTransfer } = require('../utils/callTransfer');
      const result = await warmTransfer('call-123', '+15551234567', 'Caller needs help with billing');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.retellai.com/v2/transfer-call/call-123');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.transfer_to).toBe('+15551234567');
      expect(body.message).toBe('Caller needs help with billing');
    });

    test('returns failure when RETELL_API_KEY is missing', async () => {
      delete process.env.RETELL_API_KEY;
      jest.resetModules();
      const { warmTransfer } = require('../utils/callTransfer');
      const result = await warmTransfer('call-123', '+15551234567');

      expect(result.success).toBe(false);
      expect(result.error).toContain('RETELL_API_KEY');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('returns failure when Retell API returns non-ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });

      const { warmTransfer } = require('../utils/callTransfer');
      const result = await warmTransfer('call-123', '+15551234567');

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test('handles network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const { warmTransfer } = require('../utils/callTransfer');
      const result = await warmTransfer('call-123', '+15551234567');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
    });

    test('sends without intro message when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'transferred' }),
      });

      const { warmTransfer } = require('../utils/callTransfer');
      await warmTransfer('call-123', '+15551234567');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.transfer_to).toBe('+15551234567');
      expect(body.message).toBeUndefined();
    });
  });

  describe('coldTransfer', () => {
    test('sends Twilio call update with inline TwiML', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sid: 'CA123', status: 'in-progress' }),
      });

      const { coldTransfer } = require('../utils/callTransfer');
      const result = await coldTransfer('CA123456789', '+15559876543');

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('api.twilio.com');
      expect(url).toContain('CA123456789');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(opts.body);
      const twiml = params.get('Twiml');
      expect(twiml).toContain('<Dial');
      expect(twiml).toContain('+15559876543');
      expect(twiml).toContain('timeout="30"');
      expect(twiml).toContain('<Record');
      expect(twiml).toContain('<Say');
    });

    test('returns failure when Twilio is not configured', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      jest.resetModules();
      const { coldTransfer } = require('../utils/callTransfer');
      const result = await coldTransfer('CA123', '+15551234567');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Twilio not configured');
    });

    test('returns failure on Twilio API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Call not found',
      });

      const { coldTransfer } = require('../utils/callTransfer');
      const result = await coldTransfer('CA_invalid', '+15551234567');

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test('includes Basic auth header with Twilio credentials', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sid: 'CA123' }),
      });

      const { coldTransfer } = require('../utils/callTransfer');
      await coldTransfer('CA123', '+15551234567');

      const authHeader = mockFetch.mock.calls[0][1].headers['Authorization'];
      expect(authHeader).toMatch(/^Basic /);
      const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString();
      expect(decoded).toBe('ACtest123456789:test-twilio-auth-token-for-ci');
    });
  });

  describe('handleTransfer integration', () => {
    let mockDb;
    let handleTransfer;

    beforeEach(() => {
      jest.resetModules();

      process.env.RETELL_API_KEY = 'test-retell-key';
      process.env.TWILIO_ACCOUNT_SID = 'ACtest123456789';
      process.env.TWILIO_AUTH_TOKEN = 'test-twilio-auth-token-for-ci';
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars';
      process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-chars-long';

      jest.mock('../utils/sms', () => ({
        sendSMS: jest.fn().mockResolvedValue({ success: true }),
        sendSMSToOwner: jest.fn().mockResolvedValue({ success: true }),
        SMS_PROVIDER: 'twilio',
        cleanupSMSTimers: jest.fn(),
        initRateLimiterFromDB: jest.fn(),
      }));
      jest.mock('../utils/telegram', () => ({
        sendMessage: jest.fn().mockResolvedValue({ ok: true }),
        formatTransferAlert: jest.fn().mockReturnValue({ text: 'Transfer alert' }),
        esc: jest.fn((s) => String(s || '')),
        _telegramBreaker: { call: jest.fn() },
      }));
      jest.mock('../utils/callTransfer', () => ({
        warmTransfer: jest.fn(),
        coldTransfer: jest.fn(),
      }));
      jest.mock('../routes/retell/brain', () => ({
        retellBreaker: {
          call: jest.fn(),
        },
        anthropicBreaker: {
          call: jest.fn(),
        },
        fetchCallTranscript: jest.fn(),
        generateCallSummaryAndScore: jest.fn(),
        determineOutcome: jest.fn(),
      }));

      mockDb = {
        query: jest.fn(),
      };

      handleTransfer = require('../routes/retell/followups').handleTransfer;
    });

    test('attempts warm transfer first, succeeds', async () => {
      const { warmTransfer } = require('../utils/callTransfer');
      const { retellBreaker, anthropicBreaker } = require('../routes/retell/brain');

      warmTransfer.mockResolvedValue({ success: true });

      retellBreaker.call.mockResolvedValue({
        fallback: false,
        json: async () => ({
          transcript: 'Agent: Hello\nUser: I need help',
          twilio_call_id: 'CA123',
        }),
      });

      anthropicBreaker.call.mockResolvedValue({
        fallback: false,
        content: [{ text: 'Caller needs billing help' }],
      });

      mockDb.query
        .mockResolvedValueOnce({ client_id: 'client-1', twilio_call_sid: null }) // SELECT from calls (callRecord)
        .mockResolvedValueOnce({ changes: 1 }) // UPDATE calls
        .mockResolvedValueOnce({ // SELECT from clients
          owner_phone: '+15550001111',
          transfer_phone: '+15550002222',
          telegram_chat_id: '123456',
          business_name: 'Test Biz',
          phone_number: '+15550003333',
        });

      await handleTransfer(mockDb, { call_id: 'call-123', from_number: '+15559999999' }, 'corr-1');

      expect(warmTransfer).toHaveBeenCalledWith(
        'call-123',
        '+15550002222',
        expect.stringContaining('Caller needs billing help')
      );
    });

    test('falls back to cold transfer when warm fails', async () => {
      const { warmTransfer, coldTransfer } = require('../utils/callTransfer');
      const { retellBreaker, anthropicBreaker } = require('../routes/retell/brain');

      warmTransfer.mockResolvedValue({ success: false, error: 'Retell unavailable' });
      coldTransfer.mockResolvedValue({ success: true });

      retellBreaker.call.mockResolvedValue({
        fallback: false,
        json: async () => ({
          transcript: 'short call',
          twilio_call_id: 'CA_twilio_123',
        }),
      });
      anthropicBreaker.call.mockResolvedValue({
        fallback: false,
        content: [{ text: 'Transfer summary' }],
      });

      mockDb.query
        .mockResolvedValueOnce({ client_id: 'client-1', twilio_call_sid: 'CA_twilio_123' }) // SELECT from calls (callRecord)
        .mockResolvedValueOnce({ changes: 1 }) // UPDATE calls
        .mockResolvedValueOnce({
          owner_phone: '+15550001111',
          transfer_phone: '+15550002222',
          telegram_chat_id: '123456',
          business_name: 'Test Biz',
          phone_number: '+15550003333',
        });

      await handleTransfer(mockDb, { call_id: 'call-123', from_number: '+15559999999' }, 'corr-2');

      expect(warmTransfer).toHaveBeenCalled();
      expect(coldTransfer).toHaveBeenCalledWith('CA_twilio_123', '+15550002222');
    });

    test('falls back to notification when both warm and cold fail', async () => {
      const { warmTransfer, coldTransfer } = require('../utils/callTransfer');
      const telegram = require('../utils/telegram');
      const sms = require('../utils/sms');
      const { retellBreaker, anthropicBreaker } = require('../routes/retell/brain');

      warmTransfer.mockResolvedValue({ success: false, error: 'fail' });
      coldTransfer.mockResolvedValue({ success: false, error: 'fail' });

      retellBreaker.call.mockResolvedValue({
        fallback: false,
        json: async () => ({ transcript: 'test', twilio_call_id: 'CA123' }),
      });
      anthropicBreaker.call.mockResolvedValue({
        fallback: false,
        content: [{ text: 'Summary' }],
      });

      mockDb.query
        .mockResolvedValueOnce({ client_id: 'client-1', twilio_call_sid: 'CA123' }) // SELECT from calls (callRecord)
        .mockResolvedValueOnce({ changes: 1 }) // UPDATE calls
        .mockResolvedValueOnce({
          owner_phone: '+15550001111',
          transfer_phone: '+15550002222',
          telegram_chat_id: '123456',
          business_name: 'Test Biz',
          phone_number: '+15550003333',
        });

      await handleTransfer(mockDb, { call_id: 'call-123', from_number: '+15559999999' }, 'corr-3');

      // Should send fallback SMS to owner
      expect(sms.sendSMS).toHaveBeenCalledWith(
        '+15550001111',
        expect.stringContaining('URGENT'),
        '+15550003333',
        expect.anything(),
        'client-1'
      );
      // Should send Telegram fallback
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('TRANSFER FAILED')
      );
    });

    test('uses owner_phone when transfer_phone is not set', async () => {
      const { warmTransfer } = require('../utils/callTransfer');
      const { retellBreaker, anthropicBreaker } = require('../routes/retell/brain');

      warmTransfer.mockResolvedValue({ success: true });

      retellBreaker.call.mockResolvedValue({
        fallback: false,
        json: async () => ({ transcript: 'test' }),
      });
      anthropicBreaker.call.mockResolvedValue({
        fallback: false,
        content: [{ text: 'Summary' }],
      });

      mockDb.query
        .mockResolvedValueOnce({ client_id: 'client-1', twilio_call_sid: null }) // SELECT from calls (callRecord)
        .mockResolvedValueOnce({ changes: 1 }) // UPDATE calls
        .mockResolvedValueOnce({
          owner_phone: '+15550001111',
          transfer_phone: null,
          telegram_chat_id: null,
          business_name: 'Test Biz',
          phone_number: '+15550003333',
        });

      await handleTransfer(mockDb, { call_id: 'call-123', from_number: '+15559999999' }, 'corr-4');

      expect(warmTransfer).toHaveBeenCalledWith(
        'call-123',
        '+15550001111',
        expect.any(String)
      );
    });

    test('notifies fallback when no transfer target available', async () => {
      const telegram = require('../utils/telegram');
      const { retellBreaker, anthropicBreaker } = require('../routes/retell/brain');

      retellBreaker.call.mockResolvedValue({
        fallback: false,
        json: async () => ({ transcript: 'test' }),
      });
      anthropicBreaker.call.mockResolvedValue({
        fallback: false,
        content: [{ text: 'Summary' }],
      });

      mockDb.query
        .mockResolvedValueOnce({ client_id: 'client-1', twilio_call_sid: null }) // SELECT from calls (callRecord)
        .mockResolvedValueOnce({ changes: 1 }) // UPDATE calls
        .mockResolvedValueOnce({
          owner_phone: null,
          transfer_phone: null,
          telegram_chat_id: '123456',
          business_name: 'Test Biz',
          phone_number: '+15550003333',
        });

      await handleTransfer(mockDb, { call_id: 'call-123', from_number: '+15559999999' }, 'corr-5');

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('TRANSFER FAILED')
      );
    });

    test('handles missing call gracefully', async () => {
      await handleTransfer(mockDb, null, 'corr-6');
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    test('handles missing call_id gracefully', async () => {
      await handleTransfer(mockDb, {}, 'corr-7');
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    test('notifies both transfer_phone and owner_phone when they differ', async () => {
      const { warmTransfer } = require('../utils/callTransfer');
      const sms = require('../utils/sms');
      const { retellBreaker, anthropicBreaker } = require('../routes/retell/brain');

      warmTransfer.mockResolvedValue({ success: true });

      retellBreaker.call.mockResolvedValue({
        fallback: false,
        json: async () => ({ transcript: 'test' }),
      });
      anthropicBreaker.call.mockResolvedValue({
        fallback: false,
        content: [{ text: 'Summary' }],
      });

      mockDb.query
        .mockResolvedValueOnce({ client_id: 'client-1', twilio_call_sid: null }) // SELECT from calls (callRecord)
        .mockResolvedValueOnce({ changes: 1 }) // UPDATE calls
        .mockResolvedValueOnce({
          owner_phone: '+15550001111',
          transfer_phone: '+15550002222',
          telegram_chat_id: '123456',
          business_name: 'Test Biz',
          phone_number: '+15550003333',
        });

      await handleTransfer(mockDb, { call_id: 'call-123', from_number: '+15559999999' }, 'corr-8');

      // Transfer target gets SMS
      expect(sms.sendSMS).toHaveBeenCalledWith(
        '+15550002222',
        expect.stringContaining('transfer'),
        '+15550003333',
        expect.anything(),
        'client-1'
      );
      // Owner also gets notified since phones differ
      expect(sms.sendSMS).toHaveBeenCalledWith(
        '+15550001111',
        expect.stringContaining('Transfer routed'),
        '+15550003333',
        expect.anything(),
        'client-1'
      );
    });
  });
});
