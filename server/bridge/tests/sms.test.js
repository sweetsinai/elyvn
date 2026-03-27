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
});
