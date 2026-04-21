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
});
