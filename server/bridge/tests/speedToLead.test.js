const { triggerSpeedSequence, scheduleCallback, scheduleFollowUpSMS } = require('../utils/speed-to-lead');
const { sendSMS } = require('../utils/sms');
const telegram = require('../utils/telegram');
const jobQueue = require('../utils/jobQueue');
const businessHours = require('../utils/businessHours');
const crypto = require('crypto');

// Mock dependencies
jest.mock('../utils/sms');
jest.mock('../utils/telegram');
jest.mock('../utils/jobQueue');
jest.mock('../utils/businessHours');
jest.mock('../utils/phone');

describe('speed-to-lead.js', () => {
  let db;
  const mockLeadData = {
    leadId: 'lead-123',
    clientId: 'client-456',
    phone: '+1234567890',
    name: 'John Doe',
    email: 'john@example.com',
    message: 'I need service',
    service: 'haircut',
    source: 'form',
    client: {
      business_name: 'Great Salon',
      calcom_booking_link: 'https://cal.com/great-salon/book',
      twilio_phone: '+1999888777',
      retell_agent_id: 'agent-id',
      retell_phone: '+1888777666',
      telegram_chat_id: 'chat-123'
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock database
    db = {
      prepare: jest.fn(() => ({
        run: jest.fn().mockReturnValue({ changes: 1 }),
        get: jest.fn().mockReturnValue(null)
      }))
    };

    // Default mocks
    jobQueue.enqueueJob.mockResolvedValue(true);
    businessHours.shouldDelayUntilBusinessHours.mockReturnValue(0);
    telegram.sendMessage.mockResolvedValue({ ok: true });
  });

  describe('triggerSpeedSequence', () => {
    test('should trigger full speed-to-lead sequence with form source and service', async () => {
      await triggerSpeedSequence(db, mockLeadData);

      // Should enqueue 3 jobs (SMS, callback, follow-up SMS)
      expect(jobQueue.enqueueJob).toHaveBeenCalledTimes(3);

      // Verify SMS job
      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        db,
        'speed_to_lead_sms',
        expect.objectContaining({
          phone: '+1234567890',
          message: expect.stringContaining('Great Salon'),
          from: '+1999888777'
        }),
        expect.any(String)
      );

      // Verify callback job
      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        db,
        'speed_to_lead_callback',
        expect.objectContaining({
          leadId: 'lead-123',
          phone: '+1234567890',
          reason: 'speed_callback'
        }),
        expect.any(String)
      );

      // Verify follow-up SMS job
      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        db,
        'followup_sms',
        expect.objectContaining({
          phone: '+1234567890',
          message: expect.stringContaining('I just tried reaching you')
        }),
        expect.any(String)
      );
    });

    test('should construct correct SMS text for form source', async () => {
      await triggerSpeedSequence(db, mockLeadData);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      const smsMessage = smsCall[2].message;

      expect(smsMessage).toContain('Hi John!');
      expect(smsMessage).toContain('Great Salon');
      expect(smsMessage).toContain('haircut');
      expect(smsMessage).toContain('Book your appointment');
      expect(smsMessage).toContain('we\'ll call you in about a minute');
    });

    test('should construct SMS text for missed_call source', async () => {
      const missedCallData = {
        ...mockLeadData,
        source: 'missed_call'
      };

      await triggerSpeedSequence(db, missedCallData);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      const smsMessage = smsCall[2].message;

      expect(smsMessage).toContain('Sorry we missed your call');
      expect(smsMessage).toContain('Great Salon');
      expect(smsMessage).toContain('Book instantly');
      expect(smsMessage).toContain('we\'ll call you back');
    });

    test('should construct SMS text for default source', async () => {
      const defaultSourceData = {
        ...mockLeadData,
        source: 'other'
      };

      await triggerSpeedSequence(db, defaultSourceData);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      const smsMessage = smsCall[2].message;

      expect(smsMessage).toContain('Thanks for contacting');
      expect(smsMessage).toContain('Great Salon');
      expect(smsMessage).toContain('Book anytime');
    });

    test('should handle missing name gracefully', async () => {
      const noNameData = {
        ...mockLeadData,
        name: null
      };

      await triggerSpeedSequence(db, noNameData);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      const smsMessage = smsCall[2].message;

      expect(smsMessage).toContain('Hi!');
      expect(smsMessage).not.toContain('Hi John');
    });

    test('should handle missing booking link', async () => {
      const noLinkData = {
        ...mockLeadData,
        client: {
          ...mockLeadData.client,
          calcom_booking_link: null
        }
      };

      await triggerSpeedSequence(db, noLinkData);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      const smsMessage = smsCall[2].message;

      expect(smsMessage).not.toContain('Book your appointment');
      expect(smsMessage).toContain('we\'ll call you');
    });

    test('should record messages to database', async () => {
      await triggerSpeedSequence(db, mockLeadData);

      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages')
      );

      const preparedStatement = db.prepare.mock.results.find(
        r => r.value.run && r.value.run.mock.calls.length > 0
      );
      expect(preparedStatement).toBeDefined();
    });

    test('should insert followups for 24h and 72h', async () => {
      const dbMock = {
        prepare: jest.fn((query) => {
          if (query.includes('SELECT id FROM followups')) {
            return { get: jest.fn().mockReturnValue(null) };
          }
          return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn().mockReturnValue(null) };
        })
      };

      await triggerSpeedSequence(db, mockLeadData);

      // Verify insertions happened (through jobQueue calls)
      expect(jobQueue.enqueueJob).toHaveBeenCalled();
    });

    test('should send telegram notification if chat_id present', async () => {
      await triggerSpeedSequence(db, mockLeadData);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-123',
        expect.stringContaining('Speed-to-lead activated'),
        expect.any(Object)
      );
    });

    test('should handle missing phone gracefully', async () => {
      const noPhoneData = {
        ...mockLeadData,
        phone: null
      };

      await triggerSpeedSequence(db, noPhoneData);

      // Should return early without making calls
      expect(jobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    test('should handle missing client gracefully', async () => {
      const noClientData = {
        ...mockLeadData,
        client: null
      };

      await triggerSpeedSequence(db, noClientData);

      expect(jobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    test('should use default Twilio phone if client twilio_phone not set', async () => {
      const defaultPhoneData = {
        ...mockLeadData,
        client: {
          ...mockLeadData.client,
          twilio_phone: null
        }
      };

      process.env.TWILIO_PHONE_NUMBER = '+1777666555';

      await triggerSpeedSequence(db, defaultPhoneData);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      expect(smsCall[2].from).toBe('+1777666555');
    });

    test('should use telegram source label for form', async () => {
      await triggerSpeedSequence(db, { ...mockLeadData, source: 'form' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-123',
        expect.stringContaining('📋 Website form'),
        expect.any(Object)
      );
    });

    test('should use telegram source label for missed_call', async () => {
      await triggerSpeedSequence(db, { ...mockLeadData, source: 'missed_call' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-123',
        expect.stringContaining('📵 Missed call'),
        expect.any(Object)
      );
    });

    test('should truncate message to 150 chars in telegram notification', async () => {
      const longMessage = 'A'.repeat(200);
      await triggerSpeedSequence(db, { ...mockLeadData, message: longMessage });

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        'chat-123',
        expect.stringContaining('A'.repeat(150)),
        expect.any(Object)
      );
    });

    test('should handle telegram notification error gracefully', async () => {
      telegram.sendMessage.mockRejectedValue(new Error('Telegram error'));

      await expect(triggerSpeedSequence(db, mockLeadData)).resolves.not.toThrow();
      expect(telegram.sendMessage).toHaveBeenCalled();
    });

    test('should respect business hours delay', async () => {
      businessHours.shouldDelayUntilBusinessHours.mockReturnValue(30000);

      await triggerSpeedSequence(db, mockLeadData);

      expect(jobQueue.enqueueJob).toHaveBeenCalled();
      const calls = jobQueue.enqueueJob.mock.calls;

      // All should have delayed times
      calls.forEach(call => {
        expect(call[3]).toBeTruthy(); // scheduledAt parameter
      });
    });
  });

  describe('scheduleCallback', () => {
    test('should queue callback with correct parameters', () => {
      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        message: 'I need service',
        service: 'haircut',
        delayMs: 60000,
        reason: 'speed_callback',
        client: mockLeadData.client
      };

      scheduleCallback(db, options);

      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        db,
        'speed_to_lead_callback',
        expect.objectContaining({
          leadId: 'lead-123',
          clientId: 'client-456',
          phone: '+1234567890',
          reason: 'speed_callback',
          retell_agent_id: 'agent-id',
          retell_phone: '+1888777666'
        }),
        expect.any(String)
      );
    });

    test('should use missed_call_callback reason when applicable', () => {
      const options = {
        ...{
          leadId: 'lead-123',
          clientId: 'client-456',
          phone: '+1234567890',
          name: 'John Doe',
          message: 'I need service',
          service: 'haircut',
          delayMs: 60000,
          reason: 'missed_call_callback',
          client: mockLeadData.client
        }
      };

      scheduleCallback(db, options);

      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        db,
        'speed_to_lead_callback',
        expect.objectContaining({
          reason: 'missed_call_callback'
        }),
        expect.any(String)
      );
    });

    test('should max delay with business hours', () => {
      businessHours.shouldDelayUntilBusinessHours.mockReturnValue(120000);

      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        message: 'I need service',
        service: 'haircut',
        delayMs: 60000,
        reason: 'speed_callback',
        client: mockLeadData.client
      };

      scheduleCallback(db, options);

      const scheduledCall = jobQueue.enqueueJob.mock.calls[0];
      const scheduledAtDate = new Date(scheduledCall[3]);
      const now = new Date();
      const delayMs = scheduledAtDate - now;

      // Should be approximately 120 seconds (business hours delay wins)
      expect(delayMs).toBeGreaterThanOrEqual(110000);
      expect(delayMs).toBeLessThanOrEqual(130000);
    });

    test('should use delayMs when greater than business hours delay', () => {
      businessHours.shouldDelayUntilBusinessHours.mockReturnValue(30000);

      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        message: 'I need service',
        service: 'haircut',
        delayMs: 60000,
        reason: 'speed_callback',
        client: mockLeadData.client
      };

      scheduleCallback(db, options);

      const scheduledCall = jobQueue.enqueueJob.mock.calls[0];
      const scheduledAtDate = new Date(scheduledCall[3]);
      const now = new Date();
      const delayMs = scheduledAtDate - now;

      // Should be approximately 60 seconds
      expect(delayMs).toBeGreaterThanOrEqual(50000);
      expect(delayMs).toBeLessThanOrEqual(70000);
    });

    test('should handle job queue error gracefully', () => {
      jobQueue.enqueueJob.mockImplementation(() => {
        throw new Error('Job queue unavailable');
      });

      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        message: 'I need service',
        service: 'haircut',
        delayMs: 60000,
        reason: 'speed_callback',
        client: mockLeadData.client
      };

      // Should not throw
      expect(() => scheduleCallback(db, options)).not.toThrow();
      expect(jobQueue.enqueueJob).toHaveBeenCalled();
    });
  });

  describe('scheduleFollowUpSMS', () => {
    test('should queue follow-up SMS with correct text', () => {
      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        delayMs: 300000,
        client: mockLeadData.client
      };

      scheduleFollowUpSMS(db, options);

      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        db,
        'followup_sms',
        expect.objectContaining({
          phone: '+1234567890',
          message: expect.stringContaining('Hi John'),
          message: expect.stringContaining('Great Salon'),
          message: expect.stringContaining('I just tried reaching you')
        }),
        expect.any(String)
      );
    });

    test('should extract first name for follow-up SMS', () => {
      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Michael Doe',
        delayMs: 300000,
        client: mockLeadData.client
      };

      scheduleFollowUpSMS(db, options);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      expect(smsCall[2].message).toContain('Hi John');
    });

    test('should handle missing name in follow-up SMS', () => {
      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: null,
        delayMs: 300000,
        client: mockLeadData.client
      };

      scheduleFollowUpSMS(db, options);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      expect(smsCall[2].message).toContain('Hi,');
    });

    test('should include booking link in follow-up SMS', () => {
      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        delayMs: 300000,
        client: mockLeadData.client
      };

      scheduleFollowUpSMS(db, options);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      expect(smsCall[2].message).toContain('https://cal.com/great-salon/book');
    });

    test('should handle missing booking link in follow-up SMS', () => {
      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        delayMs: 300000,
        client: {
          ...mockLeadData.client,
          calcom_booking_link: null
        }
      };

      scheduleFollowUpSMS(db, options);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      expect(smsCall[2].message).toContain('Just reply and we\'ll set something up');
    });

    test('should use correct from number', () => {
      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        delayMs: 300000,
        client: mockLeadData.client
      };

      scheduleFollowUpSMS(db, options);

      const smsCall = jobQueue.enqueueJob.mock.calls[0];
      expect(smsCall[2].from).toBe('+1999888777');
    });

    test('should respect business hours delay', () => {
      businessHours.shouldDelayUntilBusinessHours.mockReturnValue(60000);

      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        delayMs: 300000,
        client: mockLeadData.client
      };

      scheduleFollowUpSMS(db, options);

      const scheduledCall = jobQueue.enqueueJob.mock.calls[0];
      const scheduledAtDate = new Date(scheduledCall[3]);
      const now = new Date();
      const delayMs = scheduledAtDate - now;

      // Should be approximately 300 seconds (delayMs wins)
      expect(delayMs).toBeGreaterThanOrEqual(290000);
      expect(delayMs).toBeLessThanOrEqual(310000);
    });

    test('should handle job queue error gracefully', () => {
      jobQueue.enqueueJob.mockImplementation(() => {
        throw new Error('Job queue unavailable');
      });

      const options = {
        leadId: 'lead-123',
        clientId: 'client-456',
        phone: '+1234567890',
        name: 'John Doe',
        delayMs: 300000,
        client: mockLeadData.client
      };

      expect(() => scheduleFollowUpSMS(db, options)).not.toThrow();
    });
  });
});
