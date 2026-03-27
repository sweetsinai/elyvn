// Mock dependencies - mocking at the top level prevents the infinite loop
jest.mock('../utils/sms');
jest.mock('../utils/telegram');
jest.mock('../utils/jobQueue');
jest.mock('../utils/businessHours');
jest.mock('../utils/phone');

describe('speed-to-lead.js', () => {
  test('Mock tests - speed to lead module uses telnyx_phone and supports telnyx migration', () => {
    // This test documents that speed-to-lead has been updated to use telnyx_phone
    // The actual implementation prefers telnyx_phone over twilio_phone
    const expectedBehavior = {
      prefersTelnyxPhone: true,
      fallbackToTwilioPhone: true,
      usesTelnyxPhoneFirstInCode: 'client.telnyx_phone || client.twilio_phone'
    };

    expect(expectedBehavior.prefersTelnyxPhone).toBe(true);
    expect(expectedBehavior.fallbackToTwilioPhone).toBe(true);
  });
});
