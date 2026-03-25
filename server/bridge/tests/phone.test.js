'use strict';

const { normalizePhone } = require('../utils/phone');

describe('normalizePhone', () => {
  describe('10-digit US numbers', () => {
    it('should normalize plain 10-digit number', () => {
      expect(normalizePhone('2125551234')).toBe('+12125551234');
    });

    it('should normalize 10-digit with dashes', () => {
      expect(normalizePhone('212-555-1234')).toBe('+12125551234');
    });

    it('should normalize 10-digit with parentheses', () => {
      expect(normalizePhone('(212) 555-1234')).toBe('+12125551234');
    });

    it('should normalize 10-digit with spaces', () => {
      expect(normalizePhone('212 555 1234')).toBe('+12125551234');
    });

    it('should normalize 10-digit with mixed formatting', () => {
      expect(normalizePhone('(212) 555-1234')).toBe('+12125551234');
    });

    it('should normalize 10-digit with all special chars', () => {
      expect(normalizePhone('212-(555)-1234')).toBe('+12125551234');
    });
  });

  describe('11-digit US numbers with leading 1', () => {
    it('should normalize 11-digit with leading 1', () => {
      expect(normalizePhone('12125551234')).toBe('+12125551234');
    });

    it('should normalize 11-digit with leading 1 and dashes', () => {
      expect(normalizePhone('1-212-555-1234')).toBe('+12125551234');
    });

    it('should normalize 11-digit with leading 1 and parentheses', () => {
      expect(normalizePhone('1 (212) 555-1234')).toBe('+12125551234');
    });

    it('should normalize 11-digit with leading 1 and spaces', () => {
      expect(normalizePhone('1 212 555 1234')).toBe('+12125551234');
    });
  });

  describe('already formatted numbers', () => {
    it('should handle already normalized E.164 format', () => {
      expect(normalizePhone('+12125551234')).toBe('+12125551234');
    });

    it('should handle international number with + prefix', () => {
      expect(normalizePhone('+442071234567')).toBe('+442071234567');
    });

    it('should handle various international formats', () => {
      expect(normalizePhone('+33123456789')).toBe('+33123456789');
      expect(normalizePhone('+491234567890')).toBe('+491234567890');
      expect(normalizePhone('+39123456789')).toBe('+39123456789');
    });

    it('should add + to already clean international number', () => {
      expect(normalizePhone('442071234567')).toBe('+442071234567');
    });
  });

  describe('numeric input', () => {
    it('should handle numeric input for 10-digit number', () => {
      expect(normalizePhone(2125551234)).toBe('+12125551234');
    });

    it('should handle numeric input for 11-digit number with leading 1', () => {
      expect(normalizePhone(12125551234)).toBe('+12125551234');
    });

    it('should handle numeric input as int', () => {
      expect(normalizePhone(9876543210)).toBe('+19876543210');
    });
  });

  describe('null/falsy input', () => {
    it('should return null for null input', () => {
      expect(normalizePhone(null)).toBe(null);
    });

    it('should return null for undefined input', () => {
      expect(normalizePhone(undefined)).toBe(null);
    });

    it('should return null for empty string', () => {
      expect(normalizePhone('')).toBe(null);
    });

    it('should return null for false', () => {
      expect(normalizePhone(false)).toBe(null);
    });

    it('should return null for 0', () => {
      expect(normalizePhone(0)).toBe(null);
    });
  });

  describe('too short numbers', () => {
    it('should return null for 3-digit number', () => {
      expect(normalizePhone('123')).toBe(null);
    });

    it('should return null for 9-digit number', () => {
      expect(normalizePhone('2125551')).toBe(null);
    });

    it('should return null for very short number', () => {
      expect(normalizePhone('1')).toBe(null);
    });

    it('should return null for 5-digit number', () => {
      expect(normalizePhone('12345')).toBe(null);
    });

    it('should return null for 9-digit with leading 1', () => {
      // '1123456789' is 10 digits, gets treated as 11-digit pattern
      // So this will actually return '+11123456789', not null
      expect(normalizePhone('112345678')).toBe(null); // 9 digits
    });
  });

  describe('only special characters', () => {
    it('should return null for only dashes', () => {
      expect(normalizePhone('---')).toBe(null);
    });

    it('should return null for only parentheses', () => {
      expect(normalizePhone('()()')).toBe(null);
    });

    it('should return null for mixed special chars', () => {
      expect(normalizePhone('---()--')).toBe(null);
    });

    it('should return null for spaces and dashes', () => {
      expect(normalizePhone(' - ')).toBe(null);
    });

    it('should return null for symbols and brackets', () => {
      expect(normalizePhone('[]-+.,')).toBe(null);
    });
  });

  describe('edge cases', () => {
    it('should preserve + signs in middle (not removed by regex)', () => {
      // The regex keeps + signs, so '212+555+1234' keeps the + chars
      const result = normalizePhone('212+555+1234');
      expect(result).toContain('+');
    });

    it('should handle very large number', () => {
      const largePhone = '+' + '1'.repeat(15);
      const result = normalizePhone(largePhone);
      expect(result).toContain('+');
    });

    it('should handle phone with dots', () => {
      expect(normalizePhone('212.555.1234')).toBe('+12125551234');
    });

    it('should handle phone with multiple spaces', () => {
      expect(normalizePhone('212   555   1234')).toBe('+12125551234');
    });

    it('should handle 12-digit number (extra digit)', () => {
      // 12 digits: not 11, not 10, so gets + prefix and passes length check
      const result = normalizePhone('212555123456');
      expect(result).toBe('+212555123456');
    });

    it('should handle string with alphanumeric (only extracts digits)', () => {
      // String.replace(/[^\d+]/g, '') removes non-digit, non-plus chars
      const result = normalizePhone('call 212-555-1234 now');
      expect(result).toBe('+12125551234');
    });

    it('should handle only + prefix with no digits', () => {
      expect(normalizePhone('+')).toBe(null);
    });

    it('should preserve multiple + signs (not removed by regex)', () => {
      // The regex /[^\d+]/g keeps +, so ++ is preserved
      const result = normalizePhone('++12125551234');
      expect(result).toContain('+');
    });
  });

  describe('leading digit behavior', () => {
    it('should add +1 for 10-digit starting with 2', () => {
      expect(normalizePhone('2125551234')).toBe('+12125551234');
    });

    it('should add +1 for 10-digit starting with 5', () => {
      expect(normalizePhone('5551234567')).toBe('+15551234567');
    });

    it('should add +1 for 10-digit starting with 9', () => {
      expect(normalizePhone('9876543210')).toBe('+19876543210');
    });

    it('should convert 11-digit starting with 1 to +1', () => {
      expect(normalizePhone('12125551234')).toBe('+12125551234');
    });

    it('should add + for international numbers without it', () => {
      expect(normalizePhone('442071234567')).toBe('+442071234567');
    });
  });

  describe('validation path coverage', () => {
    it('should validate and normalize in correct sequence', () => {
      // Tests the flow: clean -> check empty -> check length -> add + -> validate length -> return
      const testCases = [
        { input: '2125551234', expected: '+12125551234' },
        { input: '+12125551234', expected: '+12125551234' },
        { input: '442071234567', expected: '+442071234567' },
        { input: '', expected: null },
        { input: '123', expected: null }
      ];

      testCases.forEach(tc => {
        expect(normalizePhone(tc.input)).toBe(tc.expected);
      });
    });

    it('should reach all branches in normalization logic', () => {
      // Branch 1: cleaned.length === 11 && starts with '1'
      expect(normalizePhone('12125551234')).toBe('+12125551234');

      // Branch 2: cleaned.length === 10
      expect(normalizePhone('2125551234')).toBe('+12125551234');

      // Branch 3: doesn't start with '+'
      expect(normalizePhone('442071234567')).toBe('+442071234567');

      // Branch 4: already starts with '+' (no-op)
      expect(normalizePhone('+12125551234')).toBe('+12125551234');

      // Branch 5: final length check fail
      expect(normalizePhone('123')).toBe(null);
    });
  });

  describe('type coercion', () => {
    it('should coerce number to string', () => {
      const result = normalizePhone(2125551234);
      expect(typeof result).toBe('string');
      expect(result).toBe('+12125551234');
    });

    it('should handle boolean input (coerced to string)', () => {
      const result = normalizePhone(true);
      expect(result).toBe(null); // 'true' -> no digits
    });
  });

  describe('real-world scenarios', () => {
    it('should normalize typical user input variations', () => {
      const variations = [
        '212-555-1234',
        '(212) 555-1234',
        '(212)555-1234',
        '212 555 1234',
        '2125551234',
        '1-212-555-1234',
        '+1-212-555-1234'
      ];

      variations.forEach(v => {
        expect(normalizePhone(v)).toBe('+12125551234');
      });
    });

    it('should normalize international variations', () => {
      const intl = [
        '44 207 1234567',
        '44-207-1234567',
        '+44 207 1234567',
        '442071234567'
      ];

      intl.forEach(v => {
        const result = normalizePhone(v);
        expect(result).toContain('+44');
      });
    });
  });
});
