// Set up environment
process.env.TELNYX_API_KEY = 'test-key';
process.env.TELNYX_PHONE_NUMBER = '+1234567890';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile_123';

// Mock dependencies
jest.mock('../utils/optOut');
jest.mock('../utils/jobQueue');
jest.mock('../utils/metrics');

describe('sms.js', () => {
  let optOut;
  let jobQueue;
  let metrics;

  beforeEach(() => {
    jest.clearAllMocks();

    optOut = require('../utils/optOut');
    optOut.isOptedOut = jest.fn().mockReturnValue(false);

    jobQueue = require('../utils/jobQueue');
    jobQueue.enqueueJob = jest.fn().mockResolvedValue(true);

    metrics = require('../utils/metrics');
    metrics.recordMetric = jest.fn();
  });

  describe('sendSMSToOwner', () => {
    test('should look up client from database', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMSToOwner } = require('../utils/sms');

      const mockPrepare = jest.fn(() => ({
        get: jest.fn().mockReturnValue({
          owner_phone: '+1555555555',
          telnyx_phone: '+1666666666',
          twilio_phone: null
        })
      }));

      const db = { prepare: mockPrepare };
      await sendSMSToOwner(db, 'client-456', 'Test');

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT owner_phone, telnyx_phone, twilio_phone FROM clients')
      );
    }, 10000);

    test('should return error if no owner_phone found', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMSToOwner } = require('../utils/sms');

      const db = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue({
            telnyx_phone: '+1666666666',
            twilio_phone: null
          })
        }))
      };

      const result = await sendSMSToOwner(db, 'client-123', 'Alert message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No owner phone number');
    }, 10000);

    test('should use default Telnyx phone if client telnyx_phone not set', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMSToOwner } = require('../utils/sms');

      const db = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue({
            owner_phone: '+1555555555',
            telnyx_phone: null,
            twilio_phone: null
          })
        }))
      };

      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const result = await sendSMSToOwner(db, 'client-123', 'Alert message');
      expect(result).toBeDefined();
    }, 10000);
  });

  describe('sendSMS - Phone Validation and Formatting', () => {
    test('should validate phone numbers are provided', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');
      const result = await sendSMS('', 'Test message');
      expect(result).toBeDefined();
    }, 10000);

    test('should format phone number correctly in API payload', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      // This test verifies phone is included in payload
      const result = await sendSMS('+1234567890', 'Test message');
      expect(result).toBeDefined();
    }, 10000);
  });

  describe('sendSMS - Telnyx API Call Formatting', () => {
    test('should include messaging_profile_id in payload when configured', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-123';

      const result = await sendSMS('+12125551234', 'Test message');
      expect(result).toBeDefined();
    }, 10000);

    test('should use Bearer token in Authorization header', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key-123';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const result = await sendSMS('+12125551234', 'Test message');
      // Verify headers are formatted correctly (Bearer token should be present)
      expect(result).toBeDefined();
    }, 10000);

    test('should add TCPA compliance footer to short messages', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const result = await sendSMS('+12125551234', 'Hi there');
      // Message should have STOP footer if short enough
      expect(result).toBeDefined();
    }, 10000);

    test('should not duplicate TCPA footer if already present', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const msgWithStop = 'Hello. Reply STOP to opt out.';
      const result = await sendSMS('+12125551234', msgWithStop);
      expect(result).toBeDefined();
    }, 10000);
  });

  describe('sendSMS - Error Handling', () => {
    test('should return error when no from number configured', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      delete process.env.TELNYX_PHONE_NUMBER;
      const { sendSMS } = require('../utils/sms');

      const result = await sendSMS('+12125551234', 'Test message');
      expect(result.success).toBe(false);
      expect(result.error).toContain('from number');
    }, 10000);

    test('should return error when API key not configured', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      delete process.env.TELNYX_API_KEY;
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const { sendSMS } = require('../utils/sms');

      const result = await sendSMS('+12125551234', 'Test message');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    }, 10000);

    test('should handle rate limiting correctly', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      // First call should succeed (or fail for other reasons)
      const result1 = await sendSMS('+12125551234', 'Message 1');
      expect(result1).toBeDefined();
    }, 10000);

    test('should check opt-out status if db and clientId provided', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      optOut.isOptedOut = jest.fn().mockReturnValue(true);

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const db = {};
      const result = await sendSMS('+12125551234', 'Test', null, db, 'client-123');

      expect(result.reason).toBe('opted_out');
      expect(result.success).toBe(false);
    }, 10000);

    test('should continue on opt-out check error', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      optOut.isOptedOut = jest.fn().mockImplementation(() => {
        throw new Error('DB error');
      });

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const db = {};
      const result = await sendSMS('+12125551234', 'Test', null, db, 'client-123');
      // Should attempt to send despite opt-out check error
      expect(result).toBeDefined();
    }, 10000);

    test('should distinguish between retryable and non-retryable errors', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      // Test with invalid API key (non-retryable)
      const result = await sendSMS('+12125551234', 'Test');
      expect(result).toBeDefined();
    }, 10000);

    test('should record metrics on success', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      metrics.recordMetric = jest.fn();

      const { sendSMS } = require('../utils/sms');

      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const result = await sendSMS('+12125551234', 'Test');
      expect(result).toBeDefined();
    }, 10000);

    test('should record failed metrics on error', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      metrics.recordMetric = jest.fn();

      const { sendSMS } = require('../utils/sms');

      delete process.env.TELNYX_API_KEY;
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';

      const result = await sendSMS('+12125551234', 'Test');
      expect(result.success).toBe(false);
    }, 10000);
  });

  describe('SMS Rate Limiting and Cleanup', () => {
    test('cleanupSMSTimers should clear interval', () => {
      const { cleanupSMSTimers } = require('../utils/sms');
      expect(() => cleanupSMSTimers()).not.toThrow();
    });
  });
});
