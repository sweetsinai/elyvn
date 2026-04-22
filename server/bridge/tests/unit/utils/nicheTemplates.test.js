'use strict';

const { generateFollowUpSms, generateVoicemailText } = require('../../../utils/nicheTemplates');

describe('nicheTemplates', () => {
  const client = {
    business_name: 'Test Business',
    niche: 'dental',
    calcom_booking_link: 'https://cal.com/test'
  };

  describe('generateFollowUpSms', () => {
    it('should generate SMS with correct replacements', () => {
      const text = generateFollowUpSms(client, 'John', 'How can we help?');
      expect(text).toContain('John');
      expect(text).toContain('Test Business');
      expect(text).toContain('How can we help?');
    });

    it('should use default values for missing client data', () => {
      const text = generateFollowUpSms({}, null, null);
      expect(text).toContain('there');
      expect(text).toContain('our team');
    });

    it('should handle unknown niche gracefully', () => {
      const text = generateFollowUpSms({ niche: 'unknown' }, 'John', 'Hi');
      expect(text).toContain('John');
    });
  });

  describe('generateVoicemailText', () => {
    it('should generate voicemail text with correct replacements', () => {
      const text = generateVoicemailText(client, '+1234567890');
      expect(text).toContain('Test Business');
      expect(text).toContain('https://cal.com/test');
    });

    it('should use default values for missing client data', () => {
      const text = generateVoicemailText({}, '+1234567890');
      expect(text).toContain('our team');
    });
  });

  describe('getNichePrompt', () => {
    it('should return system prompt for known niche', () => {
      const prompt = getNichePrompt('dental');
      expect(prompt).toContain('dental office receptionist');
    });

    it('should handle unknown niche with general default', () => {
      const prompt = getNichePrompt('unknown');
      expect(prompt).toContain('professional, helpful receptionist');
    });
  });

  describe('getNicheGreeting', () => {
    it('should return greeting for known niche', () => {
      const greeting = getNicheGreeting('dental');
      expect(greeting).toContain('office assistant');
    });

    it('should return null for unknown niche', () => {
      const greeting = getNicheGreeting('nonexistent');
      expect(greeting).toContain('how can I help you today?'); // Should return general greeting
    });
  });
});
