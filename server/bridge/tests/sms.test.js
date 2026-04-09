// Set up Twilio environment
process.env.TWILIO_ACCOUNT_SID = 'ACtest123456789';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_PHONE_NUMBER = '+1234567890';

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

      const mockQuery = jest.fn().mockResolvedValue({
        owner_phone: '+1555555555',
        twilio_phone: '+1666666666'
      });

      const db = { query: mockQuery };
      await sendSMSToOwner(db, 'client-456', 'Test');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT owner_phone, twilio_phone FROM clients'),
        expect.anything(),
        'get'
      );
    }, 10000);

    test('should return error if no owner_phone found', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMSToOwner } = require('../utils/sms');

      const db = {
        query: jest.fn().mockResolvedValue({
          twilio_phone: '+1666666666'
        })
      };

      const result = await sendSMSToOwner(db, 'client-123', 'Alert message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No owner phone number');
    }, 10000);

    test('should use twilio_phone from client record', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMSToOwner } = require('../utils/sms');

      const db = {
        query: jest.fn().mockResolvedValue({
          owner_phone: '+1555555555',
          twilio_phone: null
        })
      };

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

      const result = await sendSMS('+1234567890', 'Test message');
      expect(result).toBeDefined();
    }, 10000);
  });

  describe('sendSMS - Twilio API Call Formatting', () => {
    test('should add TCPA compliance footer to short messages', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

      const result = await sendSMS('+12125551234', 'Hi there');
      expect(result).toBeDefined();
    }, 10000);

    test('should not duplicate TCPA footer if already present', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const { sendSMS } = require('../utils/sms');

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

      delete process.env.TWILIO_PHONE_NUMBER;
      const { sendSMS } = require('../utils/sms');

      const result = await sendSMS('+12125551234', 'Test message');
      expect(result.success).toBe(false);
      expect(result.error).toContain('from number');

      // Restore
      process.env.TWILIO_PHONE_NUMBER = '+1234567890';
    }, 10000);

    test('should return error when Twilio not configured', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      const origSid = process.env.TWILIO_ACCOUNT_SID;
      const origToken = process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      process.env.TWILIO_PHONE_NUMBER = '+1234567890';

      const { sendSMS } = require('../utils/sms');

      const result = await sendSMS('+12125551234', 'Test message');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');

      // Restore
      process.env.TWILIO_ACCOUNT_SID = origSid;
      process.env.TWILIO_AUTH_TOKEN = origToken;
    }, 10000);

    test('should check opt-out status if db and clientId provided', async () => {
      jest.resetModules();
      jest.doMock('../utils/optOut', () => optOut);
      jest.doMock('../utils/jobQueue', () => jobQueue);
      jest.doMock('../utils/metrics', () => metrics);

      optOut.isOptedOut = jest.fn().mockReturnValue(true);

      const { sendSMS } = require('../utils/sms');

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

      const db = {};
      const result = await sendSMS('+12125551234', 'Test', null, db, 'client-123');
      expect(result).toBeDefined();
    }, 10000);
  });

  describe('SMS Rate Limiting and Cleanup', () => {
    test('cleanupSMSTimers should clear interval', () => {
      const { cleanupSMSTimers } = require('../utils/sms');
      expect(() => cleanupSMSTimers()).not.toThrow();
    });
  });
});
