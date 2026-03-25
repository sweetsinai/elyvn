'use strict';

const { isValidUUID, isValidPhone, isValidEmail, isValidURL, sanitizeString, escapeLikePattern, validateNumericRange } = require('../utils/validate');

describe('Validation Utils', () => {
  describe('isValidUUID', () => {
    test('accepts valid UUID', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUUID('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    });

    test('rejects invalid UUID', () => {
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('')).toBe(false);
      expect(isValidUUID(null)).toBe(false);
      expect(isValidUUID(undefined)).toBe(false);
      expect(isValidUUID('../../../etc/passwd')).toBe(false);
      expect(isValidUUID(12345)).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });
  });

  describe('isValidPhone', () => {
    test('accepts valid phones', () => {
      expect(isValidPhone('+14155551234')).toBe(true);
      expect(isValidPhone('14155551234')).toBe(true);
      expect(isValidPhone('+919876543210')).toBe(true);
      expect(isValidPhone('+33123456789')).toBe(true);
    });

    test('accepts phones with formatting characters', () => {
      expect(isValidPhone('+1 (415) 555-1234')).toBe(true);
      expect(isValidPhone('(415) 555-1234')).toBe(true);
      expect(isValidPhone('415-555-1234')).toBe(true);
    });

    test('rejects invalid phones', () => {
      expect(isValidPhone('')).toBe(false);
      expect(isValidPhone('abc')).toBe(false);
      expect(isValidPhone('123')).toBe(false);
      expect(isValidPhone(null)).toBe(false);
      expect(isValidPhone(undefined)).toBe(false);
      expect(isValidPhone(12345)).toBe(false);
    });
  });

  describe('isValidEmail', () => {
    test('accepts valid emails', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name+tag@domain.co.uk')).toBe(true);
      expect(isValidEmail('alice_smith@company.com')).toBe(true);
      expect(isValidEmail('contact@subdomain.example.org')).toBe(true);
    });

    test('rejects invalid emails', () => {
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail('notanemail')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
      expect(isValidEmail('user@')).toBe(false);
      expect(isValidEmail(null)).toBe(false);
      expect(isValidEmail(undefined)).toBe(false);
      expect(isValidEmail(12345)).toBe(false);
    });

    test('respects max length of 254 chars', () => {
      const tooLong = 'a'.repeat(250) + '@test.com';
      expect(isValidEmail(tooLong)).toBe(false);

      const valid = 'a'.repeat(240) + '@test.com';
      expect(isValidEmail(valid)).toBe(true);
    });
  });

  describe('isValidURL', () => {
    test('accepts valid URLs', () => {
      expect(isValidURL('https://google.com')).toBe(true);
      expect(isValidURL('https://example.com/path?q=1')).toBe(true);
      expect(isValidURL('http://localhost:3000/api')).toBe(true);
      expect(isValidURL('https://sub.domain.example.com/path#anchor')).toBe(true);
    });

    test('rejects invalid URLs', () => {
      expect(isValidURL('')).toBe(false);
      expect(isValidURL('javascript:alert(1)')).toBe(false);
      expect(isValidURL('ftp://server.com')).toBe(false);
      expect(isValidURL('not a url')).toBe(false);
      expect(isValidURL(null)).toBe(false);
      expect(isValidURL(undefined)).toBe(false);
      expect(isValidURL(12345)).toBe(false);
    });

    test('respects max length of 2048 chars', () => {
      const tooLong = 'https://' + 'a'.repeat(2050) + '.com';
      expect(isValidURL(tooLong)).toBe(false);
    });
  });

  describe('sanitizeString', () => {
    test('removes control characters', () => {
      expect(sanitizeString('hello\x00world')).toBe('helloworld');
      expect(sanitizeString('test\x01\x02value')).toBe('testvalue');
    });

    test('trims whitespace', () => {
      expect(sanitizeString('  trimmed  ')).toBe('trimmed');
      expect(sanitizeString('\n\tpadded\t\n')).toBe('padded');
    });

    test('respects maxLen parameter', () => {
      const result = sanitizeString('a'.repeat(1000), 10);
      expect(result.length).toBe(10);
      expect(result).toBe('aaaaaaaaaa');
    });

    test('defaults to 500 max length', () => {
      const result = sanitizeString('x'.repeat(1000));
      expect(result.length).toBe(500);
    });

    test('handles non-string input gracefully', () => {
      expect(sanitizeString(null)).toBe('');
      expect(sanitizeString(undefined)).toBe('');
      expect(sanitizeString(12345)).toBe('');
    });

    test('removes multiple types of control chars', () => {
      expect(sanitizeString('clean\x08\x0B\x0C\x0Eme')).toBe('cleanme');
    });
  });

  describe('escapeLikePattern', () => {
    test('escapes SQL LIKE wildcards', () => {
      expect(escapeLikePattern('100%')).toBe('100\\%');
      expect(escapeLikePattern('under_score')).toBe('under\\_score');
      expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
    });

    test('escapes multiple wildcards', () => {
      expect(escapeLikePattern('%test_value%')).toBe('\\%test\\_value\\%');
    });

    test('leaves normal strings unchanged', () => {
      expect(escapeLikePattern('normal text')).toBe('normal text');
      expect(escapeLikePattern('test123')).toBe('test123');
    });

    test('handles empty string', () => {
      expect(escapeLikePattern('')).toBe('');
    });
  });

  describe('validateNumericRange', () => {
    test('returns value when in range', () => {
      expect(validateNumericRange(7, 0, 10, 5)).toBe(7);
      expect(validateNumericRange(0, 0, 10, 5)).toBe(0);
      expect(validateNumericRange(10, 0, 10, 5)).toBe(10);
    });

    test('returns default for out of range values', () => {
      expect(validateNumericRange(999, 1, 100, 50)).toBe(50);
      expect(validateNumericRange(-1, 0, 10, 5)).toBe(5);
      expect(validateNumericRange(11, 0, 10, 5)).toBe(5);
    });

    test('coerces string numbers', () => {
      expect(validateNumericRange('3', 0, 10, 5)).toBe(3);
      expect(validateNumericRange('7.5', 0, 10, 5)).toBe(7.5);
    });

    test('returns default for invalid inputs', () => {
      expect(validateNumericRange('abc', 0, 10, 5)).toBe(5);
      expect(validateNumericRange(null, 0, 10, 5)).toBe(5);
      expect(validateNumericRange(undefined, 0, 10, 5)).toBe(5);
      expect(validateNumericRange({}, 0, 10, 5)).toBe(5);
    });

    test('handles edge cases with negative ranges', () => {
      expect(validateNumericRange(-5, -10, 0, -1)).toBe(-5);
      expect(validateNumericRange(5, -10, 0, -1)).toBe(-1);
    });
  });
});
