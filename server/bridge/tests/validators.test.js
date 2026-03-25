'use strict';

const {
  isValidUUID,
  isValidPhone,
  isValidEmail,
  isValidStage,
  isValidAction,
  sanitizeString,
  VALID_STAGES,
  VALID_ACTIONS,
  UUID_RE,
  PHONE_RE,
  EMAIL_RE
} = require('../utils/validators');

describe('Validators', () => {
  describe('isValidUUID', () => {
    describe('valid UUIDs', () => {
      it('should accept valid UUID format', () => {
        expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      });

      it('should accept valid UUID with uppercase letters', () => {
        expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
      });

      it('should accept valid UUID with mixed case', () => {
        expect(isValidUUID('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
      });

      it('should accept various valid UUIDs', () => {
        expect(isValidUUID('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
        expect(isValidUUID('00000000-0000-0000-0000-000000000000')).toBe(true);
        expect(isValidUUID('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);
      });
    });

    describe('invalid UUIDs', () => {
      it('should reject empty string', () => {
        expect(isValidUUID('')).toBe(false);
      });

      it('should reject non-string input', () => {
        expect(isValidUUID(null)).toBe(false);
        expect(isValidUUID(undefined)).toBe(false);
        expect(isValidUUID(12345)).toBe(false);
        expect(isValidUUID({})).toBe(false);
        expect(isValidUUID([])).toBe(false);
      });

      it('should reject UUID without dashes', () => {
        expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false);
      });

      it('should reject UUID with wrong dash positions', () => {
        expect(isValidUUID('550e840-0e29b-41d4a-716-446655440000')).toBe(false);
      });

      it('should reject UUID with invalid characters', () => {
        expect(isValidUUID('550e8400-e29b-41d4-a716-44665544000g')).toBe(false);
        expect(isValidUUID('550e8400-e29b-41d4-a716-44665544000!')).toBe(false);
      });

      it('should reject too short/long UUIDs', () => {
        expect(isValidUUID('550e8400-e29b-41d4-a716-4466554400')).toBe(false);
        expect(isValidUUID('550e8400-e29b-41d4-a716-44665544000000')).toBe(false);
      });

      it('should reject UUID-like but invalid formats', () => {
        expect(isValidUUID('not-a-uuid')).toBe(false);
        expect(isValidUUID('../../../etc/passwd')).toBe(false);
      });
    });
  });

  describe('isValidPhone', () => {
    describe('valid phones', () => {
      it('should accept E.164 format', () => {
        expect(isValidPhone('+12125551234')).toBe(true);
        expect(isValidPhone('+442071234567')).toBe(true);
        expect(isValidPhone('+919876543210')).toBe(true);
      });

      it('should accept simple format without plus', () => {
        expect(isValidPhone('14155551234')).toBe(true);
        expect(isValidPhone('2125551234')).toBe(true);
      });

      it('should accept formatted numbers', () => {
        expect(isValidPhone('+1 (212) 555-1234')).toBe(true);
        expect(isValidPhone('+1 212-555-1234')).toBe(true);
        expect(isValidPhone('(212) 555-1234')).toBe(true);
        expect(isValidPhone('212-555-1234')).toBe(true);
        expect(isValidPhone('212 555 1234')).toBe(true);
      });

      it('should accept minimum valid phone (10+ digits)', () => {
        expect(isValidPhone('+12125551234')).toBe(true); // 11 digits after +
      });

      it('should accept various international formats', () => {
        expect(isValidPhone('+33123456789')).toBe(true); // France
        expect(isValidPhone('+491234567890')).toBe(true); // Germany
        expect(isValidPhone('+39123456789')).toBe(true); // Italy
      });

      it('should accept with spaces and dashes removed', () => {
        expect(isValidPhone('+1 (212) 555-1234')).toBe(true);
        expect(isValidPhone('1 (212) 555-1234')).toBe(true);
      });
    });

    describe('invalid phones', () => {
      it('should reject empty string', () => {
        expect(isValidPhone('')).toBe(false);
      });

      it('should reject non-string input', () => {
        expect(isValidPhone(null)).toBe(false);
        expect(isValidPhone(undefined)).toBe(false);
        expect(isValidPhone(12345)).toBe(false);
        expect(isValidPhone({})).toBe(false);
      });

      it('should reject too short numbers', () => {
        expect(isValidPhone('123')).toBe(false);
        expect(isValidPhone('12345')).toBe(false); // Less than 7 digits
        expect(isValidPhone('+12345')).toBe(false); // Less than 7 digits
      });

      it('should reject numbers with leading zero', () => {
        expect(isValidPhone('+012125551234')).toBe(false);
        expect(isValidPhone('012125551234')).toBe(false);
      });

      it('should reject non-numeric input', () => {
        expect(isValidPhone('abc-def-ghij')).toBe(false);
        expect(isValidPhone('not-a-phone')).toBe(false);
      });

      it('should reject with invalid country code (0 or leading 0)', () => {
        expect(isValidPhone('+0123456789')).toBe(false);
        expect(isValidPhone('012345678')).toBe(false); // Starting with 0
      });
    });
  });

  describe('isValidEmail', () => {
    describe('valid emails', () => {
      it('should accept basic email format', () => {
        expect(isValidEmail('test@example.com')).toBe(true);
      });

      it('should accept emails with dots', () => {
        expect(isValidEmail('user.name@example.com')).toBe(true);
        expect(isValidEmail('john.doe.smith@company.example.org')).toBe(true);
      });

      it('should accept emails with plus', () => {
        expect(isValidEmail('user+tag@example.com')).toBe(true);
        expect(isValidEmail('test+one+two@domain.com')).toBe(true);
      });

      it('should accept emails with underscores', () => {
        expect(isValidEmail('user_name@example.com')).toBe(true);
        expect(isValidEmail('first_last_name@domain.com')).toBe(true);
      });

      it('should accept emails with hyphens', () => {
        expect(isValidEmail('user-name@example.com')).toBe(true);
        expect(isValidEmail('my-company@my-domain.com')).toBe(true);
      });

      it('should accept emails with numbers', () => {
        expect(isValidEmail('user123@example.com')).toBe(true);
        expect(isValidEmail('test2024@domain.org')).toBe(true);
      });

      it('should accept emails with subdomain', () => {
        expect(isValidEmail('user@mail.example.com')).toBe(true);
        expect(isValidEmail('contact@subdomain.domain.co.uk')).toBe(true);
      });

      it('should accept various TLDs', () => {
        expect(isValidEmail('test@example.co')).toBe(true);
        expect(isValidEmail('test@example.info')).toBe(true);
        expect(isValidEmail('test@example.museum')).toBe(true);
      });

      it('should accept mixed case', () => {
        expect(isValidEmail('User@Example.COM')).toBe(true);
        expect(isValidEmail('TeSt@ExAmPlE.CoM')).toBe(true);
      });
    });

    describe('invalid emails', () => {
      it('should reject empty string', () => {
        expect(isValidEmail('')).toBe(false);
      });

      it('should reject non-string input', () => {
        expect(isValidEmail(null)).toBe(false);
        expect(isValidEmail(undefined)).toBe(false);
        expect(isValidEmail(12345)).toBe(false);
        expect(isValidEmail({})).toBe(false);
      });

      it('should reject missing @ symbol', () => {
        expect(isValidEmail('testexample.com')).toBe(false);
      });

      it('should reject missing domain', () => {
        expect(isValidEmail('user@')).toBe(false);
        expect(isValidEmail('user@.com')).toBe(false);
      });

      it('should reject missing local part', () => {
        expect(isValidEmail('@example.com')).toBe(false);
      });

      it('should reject missing TLD', () => {
        expect(isValidEmail('user@example')).toBe(false);
        expect(isValidEmail('user@example.')).toBe(false);
      });

      it('should reject multiple @ symbols', () => {
        expect(isValidEmail('user@test@example.com')).toBe(false);
      });

      it('should reject spaces', () => {
        expect(isValidEmail('user name@example.com')).toBe(false);
        expect(isValidEmail('user@example .com')).toBe(false);
      });

      it('should reject special characters in local part (except allowed)', () => {
        expect(isValidEmail('user!@example.com')).toBe(false);
        expect(isValidEmail('user#name@example.com')).toBe(false);
      });
    });
  });

  describe('isValidStage', () => {
    describe('valid stages', () => {
      it('should accept all valid stages', () => {
        expect(isValidStage('new')).toBe(true);
        expect(isValidStage('contacted')).toBe(true);
        expect(isValidStage('warm')).toBe(true);
        expect(isValidStage('hot')).toBe(true);
        expect(isValidStage('booked')).toBe(true);
        expect(isValidStage('completed')).toBe(true);
        expect(isValidStage('lost')).toBe(true);
        expect(isValidStage('nurture')).toBe(true);
      });
    });

    describe('invalid stages', () => {
      it('should reject invalid stage names', () => {
        expect(isValidStage('invalid')).toBe(false);
        expect(isValidStage('pending')).toBe(false);
        expect(isValidStage('qualified')).toBe(false);
      });

      it('should reject case variations', () => {
        expect(isValidStage('NEW')).toBe(false);
        expect(isValidStage('New')).toBe(false);
        expect(isValidStage('CONTACTED')).toBe(false);
      });

      it('should reject empty string', () => {
        expect(isValidStage('')).toBe(false);
      });

      it('should reject non-string input', () => {
        expect(isValidStage(null)).toBe(false);
        expect(isValidStage(undefined)).toBe(false);
        expect(isValidStage(123)).toBe(false);
        expect(isValidStage({})).toBe(false);
      });

      it('should reject partial matches', () => {
        expect(isValidStage('new-lead')).toBe(false);
        expect(isValidStage('contacted-user')).toBe(false);
      });
    });
  });

  describe('isValidAction', () => {
    describe('valid actions', () => {
      it('should accept all valid actions', () => {
        expect(isValidAction('send_sms')).toBe(true);
        expect(isValidAction('schedule_followup')).toBe(true);
        expect(isValidAction('cancel_pending_followups')).toBe(true);
        expect(isValidAction('update_lead_stage')).toBe(true);
        expect(isValidAction('update_lead_score')).toBe(true);
        expect(isValidAction('book_appointment')).toBe(true);
        expect(isValidAction('notify_owner')).toBe(true);
        expect(isValidAction('log_insight')).toBe(true);
        expect(isValidAction('no_action')).toBe(true);
      });
    });

    describe('invalid actions', () => {
      it('should reject invalid action names', () => {
        expect(isValidAction('invalid_action')).toBe(false);
        expect(isValidAction('send_email')).toBe(false);
        expect(isValidAction('delete_lead')).toBe(false);
      });

      it('should reject case variations', () => {
        expect(isValidAction('SEND_SMS')).toBe(false);
        expect(isValidAction('Send_SMS')).toBe(false);
        expect(isValidAction('SCHEDULE_FOLLOWUP')).toBe(false);
      });

      it('should reject empty string', () => {
        expect(isValidAction('')).toBe(false);
      });

      it('should reject non-string input', () => {
        expect(isValidAction(null)).toBe(false);
        expect(isValidAction(undefined)).toBe(false);
        expect(isValidAction(123)).toBe(false);
        expect(isValidAction({})).toBe(false);
      });

      it('should reject partial matches', () => {
        expect(isValidAction('send')).toBe(false);
        expect(isValidAction('schedule')).toBe(false);
      });
    });
  });

  describe('sanitizeString', () => {
    describe('control character removal', () => {
      it('should remove null character', () => {
        expect(sanitizeString('hello\x00world')).toBe('helloworld');
      });

      it('should remove various control characters', () => {
        expect(sanitizeString('test\x01\x02value')).toBe('testvalue');
        expect(sanitizeString('data\x08text')).toBe('datatext');
        expect(sanitizeString('hello\x0Bworld')).toBe('helloworld');
        expect(sanitizeString('test\x0Cvalue')).toBe('testvalue');
      });

      it('should remove multiple control characters', () => {
        expect(sanitizeString('a\x00b\x01c\x02d')).toBe('abcd');
      });

      it('should preserve regular whitespace', () => {
        expect(sanitizeString('hello world')).toBe('hello world');
        expect(sanitizeString('test\tvalue')).toBe('test\tvalue');
      });

      it('should remove range 0x0E-0x1F control characters', () => {
        expect(sanitizeString('text\x0Evalue')).toBe('textvalue');
        expect(sanitizeString('test\x1Fend')).toBe('testend');
      });
    });

    describe('length limiting', () => {
      it('should limit to default maxLen of 1000', () => {
        const result = sanitizeString('a'.repeat(1000));
        expect(result.length).toBe(1000);
        expect(result).toBe('a'.repeat(1000));
      });

      it('should truncate to provided maxLen', () => {
        const result = sanitizeString('a'.repeat(100), 10);
        expect(result.length).toBe(10);
        expect(result).toBe('aaaaaaaaaa');
      });

      it('should handle maxLen of 0', () => {
        const result = sanitizeString('hello world', 0);
        expect(result).toBe('');
      });

      it('should handle maxLen of 1', () => {
        const result = sanitizeString('hello world', 1);
        expect(result).toBe('h');
      });

      it('should handle string shorter than maxLen', () => {
        const result = sanitizeString('short', 100);
        expect(result).toBe('short');
      });

      it('should handle exact maxLen', () => {
        const result = sanitizeString('exactly10!', 10);
        expect(result).toBe('exactly10!');
      });
    });

    describe('non-string input', () => {
      it('should return empty string for null', () => {
        expect(sanitizeString(null)).toBe('');
      });

      it('should return empty string for undefined', () => {
        expect(sanitizeString(undefined)).toBe('');
      });

      it('should return empty string for non-string types', () => {
        expect(sanitizeString(12345)).toBe('');
        expect(sanitizeString(true)).toBe('');
        expect(sanitizeString({})).toBe('');
        expect(sanitizeString([])).toBe('');
      });
    });

    describe('combined scenarios', () => {
      it('should remove control chars and truncate', () => {
        const result = sanitizeString('hello\x00world'.repeat(100), 20);
        expect(result.length).toBe(20);
        expect(result).not.toContain('\x00');
      });

      it('should handle string with only control characters', () => {
        const result = sanitizeString('\x00\x01\x02\x03', 100);
        expect(result).toBe('');
      });

      it('should preserve useful content while removing control chars', () => {
        const result = sanitizeString('data:\x001234\x01test', 100);
        expect(result).toBe('data:1234test');
      });
    });
  });

  describe('Exported constants', () => {
    describe('VALID_STAGES', () => {
      it('should export valid stages array', () => {
        expect(Array.isArray(VALID_STAGES)).toBe(true);
        expect(VALID_STAGES.length).toBe(8);
      });

      it('should contain all expected stages', () => {
        expect(VALID_STAGES).toContain('new');
        expect(VALID_STAGES).toContain('contacted');
        expect(VALID_STAGES).toContain('warm');
        expect(VALID_STAGES).toContain('hot');
        expect(VALID_STAGES).toContain('booked');
        expect(VALID_STAGES).toContain('completed');
        expect(VALID_STAGES).toContain('lost');
        expect(VALID_STAGES).toContain('nurture');
      });
    });

    describe('VALID_ACTIONS', () => {
      it('should export valid actions array', () => {
        expect(Array.isArray(VALID_ACTIONS)).toBe(true);
        expect(VALID_ACTIONS.length).toBe(9);
      });

      it('should contain all expected actions', () => {
        expect(VALID_ACTIONS).toContain('send_sms');
        expect(VALID_ACTIONS).toContain('schedule_followup');
        expect(VALID_ACTIONS).toContain('cancel_pending_followups');
        expect(VALID_ACTIONS).toContain('update_lead_stage');
        expect(VALID_ACTIONS).toContain('update_lead_score');
        expect(VALID_ACTIONS).toContain('book_appointment');
        expect(VALID_ACTIONS).toContain('notify_owner');
        expect(VALID_ACTIONS).toContain('log_insight');
        expect(VALID_ACTIONS).toContain('no_action');
      });
    });
  });

  describe('Exported regex patterns', () => {
    describe('UUID_RE', () => {
      it('should match valid UUIDs', () => {
        expect(UUID_RE.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
        expect(UUID_RE.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
      });

      it('should not match invalid UUIDs', () => {
        expect(UUID_RE.test('not-a-uuid')).toBe(false);
        expect(UUID_RE.test('550e8400e29b41d4a716446655440000')).toBe(false);
      });

      it('should be case insensitive flag', () => {
        expect(UUID_RE.flags).toContain('i');
      });
    });

    describe('PHONE_RE', () => {
      it('should match valid phone numbers', () => {
        expect(PHONE_RE.test('+12125551234')).toBe(true);
        expect(PHONE_RE.test('2125551234')).toBe(true);
      });

      it('should not match invalid phones', () => {
        expect(PHONE_RE.test('123')).toBe(false);
        expect(PHONE_RE.test('+0123456789')).toBe(false);
      });
    });

    describe('EMAIL_RE', () => {
      it('should match valid emails', () => {
        expect(EMAIL_RE.test('test@example.com')).toBe(true);
        expect(EMAIL_RE.test('user+tag@domain.co.uk')).toBe(true);
      });

      it('should not match invalid emails', () => {
        expect(EMAIL_RE.test('invalid')).toBe(false);
        expect(EMAIL_RE.test('@example.com')).toBe(false);
      });
    });
  });

  describe('Integration scenarios', () => {
    it('should validate complete lead data object', () => {
      const lead = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        phone: '+12125551234',
        email: 'john@example.com',
        stage: 'hot',
        notes: 'Important\x00data'
      };

      expect(isValidUUID(lead.id)).toBe(true);
      expect(isValidPhone(lead.phone)).toBe(true);
      expect(isValidEmail(lead.email)).toBe(true);
      expect(isValidStage(lead.stage)).toBe(true);
      expect(sanitizeString(lead.notes)).toBe('Importantdata');
    });

    it('should handle mixed valid and invalid data', () => {
      const testCases = [
        { value: 'valid@email.com', validator: isValidEmail, expected: true },
        { value: '+12125551234', validator: isValidPhone, expected: true },
        { value: 'invalid-stage', validator: isValidStage, expected: false },
        { value: 'not-an-action', validator: isValidAction, expected: false }
      ];

      testCases.forEach(tc => {
        expect(tc.validator(tc.value)).toBe(tc.expected);
      });
    });
  });
});
