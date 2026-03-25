// Mock dependencies BEFORE requiring the module
jest.mock('twilio');
jest.mock('../utils/optOut');
jest.mock('../utils/jobQueue');
jest.mock('../utils/metrics');

describe('sms.js', () => {
  let mockTwilioClient;
  let mockMessagesCreate;
  let optOut;
  let jobQueue;
  let metrics;
  let sendSMS;
  let sendSMSToOwner;
  let twilio;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.useFakeTimers();

    // Set up environment BEFORE any module loading
    process.env.TWILIO_ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    process.env.TWILIO_AUTH_TOKEN = 'auth_token_123';
    process.env.TWILIO_PHONE_NUMBER = '+1234567890';

    // Mock Twilio BEFORE requiring
    mockMessagesCreate = jest.fn().mockResolvedValue({
      sid: 'SM1234567890abcdef',
      to: '+1234567890',
      body: 'Test message'
    });

    mockTwilioClient = {
      messages: {
        create: mockMessagesCreate
      }
    };

    twilio = require('twilio');
    twilio.mockReturnValue(mockTwilioClient);

    // Mock dependencies
    optOut = require('../utils/optOut');
    optOut.isOptedOut = jest.fn().mockReturnValue(false);

    jobQueue = require('../utils/jobQueue');
    jobQueue.enqueueJob = jest.fn().mockResolvedValue(true);

    metrics = require('../utils/metrics');
    metrics.recordMetric = jest.fn();

    // NOW require SMS module after all mocks are set up
    const smsModule = require('../utils/sms');
    sendSMS = smsModule.sendSMS;
    sendSMSToOwner = smsModule.sendSMSToOwner;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('sendSMS', () => {
    test('should send SMS successfully', async () => {
      const result = await sendSMS('+1234567890', 'Hello World');

      expect(result).toEqual({
        success: true,
        messageId: 'SM1234567890abcdef'
      });

      expect(mockMessagesCreate).toHaveBeenCalledWith({
        to: '+1234567890',
        from: '+1234567890',
        body: expect.stringContaining('Hello World')
      });
    });

    test('should use custom from number', async () => {
      await sendSMS('+1234567890', 'Hello', '+1999888777');

      expect(mockMessagesCreate).toHaveBeenCalledWith({
        to: '+1234567890',
        from: '+1999888777',
        body: expect.any(String)
      });
    });

    test('should add TCPA footer when message is short enough', async () => {
      await sendSMS('+1234567890', 'Hi there!');

      const call = mockMessagesCreate.mock.calls[0][0];
      expect(call.body).toContain('Reply STOP to opt out');
    });

    test('should not add TCPA footer to long messages', async () => {
      const longMessage = 'A'.repeat(156);
      await sendSMS('+1234567890', longMessage);

      const call = mockMessagesCreate.mock.calls[0][0];
      expect(call.body).toEqual(longMessage);
    });

    test('should not duplicate TCPA footer if already present', async () => {
      const messageWithFooter = 'Hi there! Reply STOP to opt out.';
      await sendSMS('+1234567890', messageWithFooter);

      const call = mockMessagesCreate.mock.calls[0][0];
      expect(call.body).toBe(messageWithFooter);
      expect(call.body.match(/Reply STOP/g).length).toBe(1);
    });

    test('should check for STOP with case insensitivity', async () => {
      const messageWithFooter = 'Hi there! reply stop to opt out.';
      await sendSMS('+1234567890', messageWithFooter);

      const call = mockMessagesCreate.mock.calls[0][0];
      expect(call.body).toBe(messageWithFooter);
      expect(call.body.match(/reply stop/i).length).toBe(1);
    });

    test('should check opt-out status if db and clientId provided', async () => {
      const db = {};

      await sendSMS('+1234567890', 'Hello', '+1234567890', db, 'client-123');

      expect(optOut.isOptedOut).toHaveBeenCalledWith(db, '+1234567890', 'client-123');
    });

    test('should skip send if number is opted out', async () => {
      optOut.isOptedOut.mockReturnValue(true);
      const db = {};

      const result = await sendSMS('+1234567890', 'Hello', '+1234567890', db, 'client-123');

      expect(result).toEqual({
        success: false,
        reason: 'opted_out'
      });

      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    test('should continue if opt-out check fails', async () => {
      optOut.isOptedOut.mockImplementation(() => {
        throw new Error('DB error');
      });
      const db = {};

      const result = await sendSMS('+1234567890', 'Hello', '+1234567890', db, 'client-123');

      expect(result.success).toBe(true);
      expect(mockMessagesCreate).toHaveBeenCalled();
    });

    test('should rate limit SMS sends to same number', async () => {
      const result1 = await sendSMS('+1234567890', 'Hello');
      expect(result1.success).toBe(true);

      const result2 = await sendSMS('+1234567890', 'Hello again');
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('Rate limited');
    });

    test('should allow sends to different numbers within rate limit', async () => {
      const result1 = await sendSMS('+1111111111', 'Hello');
      expect(result1.success).toBe(true);

      const result2 = await sendSMS('+2222222222', 'Hello');
      expect(result2.success).toBe(true);

      expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    });

    test('should allow rate-limited number to send after delay expires', async () => {
      await sendSMS('+1234567890', 'Hello');

      const result2 = await sendSMS('+1234567890', 'Again');
      expect(result2.success).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000 + 1000);

      const result3 = await sendSMS('+1234567890', 'Now OK');
      expect(result3.success).toBe(true);
    });

    test('should record success metric', async () => {
      await sendSMS('+1234567890', 'Hello');

      expect(metrics.recordMetric).toHaveBeenCalledWith('total_sms_sent', 1, 'counter');
    });

    test('should handle Twilio error and return error message', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('Invalid phone number'));

      const result = await sendSMS('+invalid', 'Hello');

      expect(result).toEqual({
        success: false,
        error: 'Invalid phone number'
      });
    });

    test('should record failed metric on error', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('API error'));

      await sendSMS('+1234567890', 'Hello');

      expect(metrics.recordMetric).toHaveBeenCalledWith('total_sms_failed', 1, 'counter');
    });

    test('should enqueue retry job on failure if db provided', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('API error'));
      const db = {};

      await sendSMS('+1234567890', 'Hello', '+1234567890', db);

      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        db,
        'followup_sms',
        expect.objectContaining({
          to: '+1234567890',
          message: 'Hello'
        }),
        expect.any(String)
      );
    });

    test('should not require db or clientId for basic send', async () => {
      const result = await sendSMS('+1234567890', 'Hello');

      expect(result.success).toBe(true);
      expect(mockMessagesCreate).toHaveBeenCalled();
    });

    test('should update rate limit after successful send', async () => {
      await sendSMS('+1234567890', 'Hello');

      const result = await sendSMS('+1234567890', 'Again');
      expect(result.success).toBe(false);
    });

    test('should truncate long messages appropriately for footer', async () => {
      const message = 'A'.repeat(155);
      await sendSMS('+1234567890', message);

      const call = mockMessagesCreate.mock.calls[0][0];
      expect(call.body).toBe(message);
    });
  });

  describe('sendSMSToOwner', () => {
    test('should send SMS to client owner phone', async () => {
      const db = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue({
            owner_phone: '+1555555555',
            twilio_phone: '+1666666666'
          })
        }))
      };

      const result = await sendSMSToOwner(db, 'client-123', 'Alert message');

      expect(result.success).toBe(true);

      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT owner_phone, twilio_phone FROM clients')
      );

      expect(mockMessagesCreate).toHaveBeenCalledWith({
        to: '+1555555555',
        from: '+1666666666',
        body: expect.stringContaining('Alert message')
      });
    });

    test('should return error if no owner_phone found', async () => {
      const db = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue({
            twilio_phone: '+1666666666'
          })
        }))
      };

      const result = await sendSMSToOwner(db, 'client-123', 'Alert message');

      expect(result).toEqual({
        success: false,
        error: 'No owner phone number'
      });

      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    test('should return error if client not found', async () => {
      const db = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue(null)
        }))
      };

      const result = await sendSMSToOwner(db, 'unknown-client', 'Alert message');

      expect(result).toEqual({
        success: false,
        error: 'No owner phone number'
      });
    });

    test('should handle database errors', async () => {
      const db = {
        prepare: jest.fn(() => {
          throw new Error('Database error');
        })
      };

      const result = await sendSMSToOwner(db, 'client-123', 'Alert message');

      expect(result).toEqual({
        success: false,
        error: 'Database error'
      });
    });

    test('should use default Twilio phone if client twilio_phone not set', async () => {
      const db = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue({
            owner_phone: '+1555555555',
            twilio_phone: null
          })
        }))
      };

      process.env.TWILIO_PHONE_NUMBER = '+1234567890';

      const result = await sendSMSToOwner(db, 'client-123', 'Alert message');

      expect(result.success).toBe(true);

      expect(mockMessagesCreate).toHaveBeenCalledWith({
        to: '+1555555555',
        from: '+1234567890',
        body: expect.any(String)
      });
    });

    test('should add TCPA footer for owner SMS', async () => {
      const db = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue({
            owner_phone: '+1555555555',
            twilio_phone: '+1666666666'
          })
        }))
      };

      await sendSMSToOwner(db, 'client-123', 'Short msg');

      const call = mockMessagesCreate.mock.calls[0][0];
      expect(call.body).toContain('Reply STOP to opt out');
    });
  });
});
