'use strict';

const {
  LENGTH_LIMITS,
  validateEmail,
  validatePhone,
  validateUrl,
  validateLength,
  sanitizeString,
  stripHtmlTags,
  validateStringField,
  validateParameters,
} = require('../utils/validators');

describe('Input Validation Utils', () => {
  describe('validateEmail', () => {
    test('accepts valid emails', () => {
      expect(validateEmail('user@example.com').valid).toBe(true);
      expect(validateEmail('user+tag@example.co.uk').valid).toBe(true);
      expect(validateEmail('test.name@subdomain.example.org').valid).toBe(true);
    });

    test('rejects invalid emails', () => {
      expect(validateEmail('').valid).toBe(false);
      expect(validateEmail(null).valid).toBe(false);
      expect(validateEmail(undefined).valid).toBe(false);
      expect(validateEmail('not-an-email').valid).toBe(false);
      expect(validateEmail('user@').valid).toBe(false);
      expect(validateEmail('@example.com').valid).toBe(false);
    });

    test('rejects emails exceeding length limit', () => {
      const longEmail = 'a'.repeat(255) + '@example.com';
      expect(validateEmail(longEmail).valid).toBe(false);
      expect(validateEmail(longEmail).error).toContain('exceeds maximum length');
    });

    test('requires email type to be string', () => {
      expect(validateEmail(123).valid).toBe(false);
      expect(validateEmail({}).valid).toBe(false);
    });
  });

  describe('validatePhone', () => {
    test('accepts valid phones', () => {
      expect(validatePhone('+14155551234').valid).toBe(true);
      expect(validatePhone('14155551234').valid).toBe(true);
      expect(validatePhone('+919876543210').valid).toBe(true);
    });

    test('accepts phones with formatting', () => {
      expect(validatePhone('+1 (415) 555-1234').valid).toBe(true);
      expect(validatePhone('(415) 555-1234').valid).toBe(true);
      expect(validatePhone('415-555-1234').valid).toBe(true);
    });

    test('rejects invalid phones', () => {
      expect(validatePhone('').valid).toBe(false);
      expect(validatePhone(null).valid).toBe(false);
      expect(validatePhone('123').valid).toBe(false);
      expect(validatePhone('abc').valid).toBe(false);
    });

    test('rejects phones exceeding length limit', () => {
      const longPhone = '+1' + '5'.repeat(25);
      expect(validatePhone(longPhone).valid).toBe(false);
      expect(validatePhone(longPhone).error).toContain('exceeds maximum length');
    });

    test('requires phone type to be string', () => {
      expect(validatePhone(123).valid).toBe(false);
      expect(validatePhone({}).valid).toBe(false);
    });
  });

  describe('validateUrl', () => {
    test('accepts valid URLs', () => {
      expect(validateUrl('https://example.com').valid).toBe(true);
      expect(validateUrl('http://example.com/path').valid).toBe(true);
      expect(validateUrl('https://sub.example.com/path?query=value').valid).toBe(true);
    });

    test('rejects invalid URLs', () => {
      expect(validateUrl('').valid).toBe(false);
      expect(validateUrl(null).valid).toBe(false);
      expect(validateUrl('ftp://example.com').valid).toBe(false);
      expect(validateUrl('example.com').valid).toBe(false);
      expect(validateUrl('not a url').valid).toBe(false);
    });

    test('rejects URLs exceeding length limit', () => {
      const longUrl = 'https://' + 'a'.repeat(2100) + '.com';
      expect(validateUrl(longUrl).valid).toBe(false);
      expect(validateUrl(longUrl).error).toContain('exceeds maximum length');
    });

    test('requires URL type to be string', () => {
      expect(validateUrl(123).valid).toBe(false);
      expect(validateUrl({}).valid).toBe(false);
    });
  });

  describe('validateLength', () => {
    test('accepts strings within length limit', () => {
      expect(validateLength('short string', 'test', 20).valid).toBe(true);
      expect(validateLength('', 'test', 20).valid).toBe(true); // Empty is optional
    });

    test('rejects strings exceeding length limit', () => {
      const str = 'a'.repeat(21);
      expect(validateLength(str, 'test', 20).valid).toBe(false);
      expect(validateLength(str, 'test', 20).error).toContain('exceeds maximum length');
    });

    test('accepts null and undefined as optional', () => {
      expect(validateLength(null, 'test', 20).valid).toBe(true);
      expect(validateLength(undefined, 'test', 20).valid).toBe(true);
    });

    test('rejects non-string types', () => {
      expect(validateLength(123, 'test', 20).valid).toBe(false);
      expect(validateLength({}, 'test', 20).valid).toBe(false);
    });
  });

  describe('sanitizeString', () => {
    test('removes control characters', () => {
      const input = 'hello\x00world\x1Ftest';
      const result = sanitizeString(input);
      expect(result).toBe('helloworldtest');
    });

    test('removes HTML tags', () => {
      const input = 'hello <script>alert("xss")</script> world';
      const result = sanitizeString(input);
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
    });

    test('trims whitespace', () => {
      const result = sanitizeString('  hello world  ');
      expect(result).toBe('hello world');
    });

    test('respects max length', () => {
      const input = 'a'.repeat(100);
      const result = sanitizeString(input, 50);
      expect(result.length).toBe(50);
    });

    test('handles non-string inputs', () => {
      expect(sanitizeString(null)).toBe('');
      expect(sanitizeString(123)).toBe('');
      expect(sanitizeString({})).toBe('');
    });
  });

  describe('stripHtmlTags', () => {
    test('removes all HTML tags', () => {
      const input = '<p>Hello <b>world</b></p>';
      const result = stripHtmlTags(input);
      expect(result).toBe('Hello world');
    });

    test('removes script tags', () => {
      const input = 'safe<script>alert("xss")</script>text';
      const result = stripHtmlTags(input);
      expect(result).toContain('safe');
      expect(result).toContain('text');
      expect(result).not.toContain('<script>');
    });

    test('handles non-string inputs', () => {
      expect(stripHtmlTags(null)).toBe('');
      expect(stripHtmlTags(123)).toBe('');
    });
  });

  describe('validateStringField', () => {
    test('accepts valid strings', () => {
      expect(validateStringField('hello', 'name').valid).toBe(true);
      expect(validateStringField('test message', 'message', 1, 50).valid).toBe(true);
    });

    test('rejects empty strings', () => {
      expect(validateStringField('', 'name').valid).toBe(false);
      expect(validateStringField(null, 'name').valid).toBe(false);
    });

    test('enforces minimum length', () => {
      expect(validateStringField('hi', 'name', 5, 50).valid).toBe(false);
      expect(validateStringField('hi', 'name', 5, 50).error).toContain('at least 5 characters');
    });

    test('enforces maximum length', () => {
      const str = 'a'.repeat(51);
      expect(validateStringField(str, 'name', 1, 50).valid).toBe(false);
      expect(validateStringField(str, 'name', 1, 50).error).toContain('exceeds maximum length');
    });

    test('requires string type', () => {
      expect(validateStringField(123, 'name').valid).toBe(false);
      expect(validateStringField({}, 'name').valid).toBe(false);
    });
  });

  describe('validateParameters', () => {
    test('validates multiple fields', () => {
      const params = { name: 'John', email: 'john@example.com', age: '30' };
      const schema = {
        name: { type: 'string', required: true },
        email: { type: 'string', required: true },
        age: { type: 'string', required: false },
      };
      const result = validateParameters(params, schema);
      expect(result.valid).toBe(true);
      expect(Object.keys(result.errors).length).toBe(0);
    });

    test('reports missing required fields', () => {
      const params = { name: 'John' };
      const schema = {
        name: { type: 'string', required: true },
        email: { type: 'string', required: true },
      };
      const result = validateParameters(params, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.email).toContain('required');
    });

    test('reports type mismatches', () => {
      const params = { name: 123, email: 'john@example.com' };
      const schema = {
        name: { type: 'string', required: true },
        email: { type: 'string', required: true },
      };
      const result = validateParameters(params, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.name).toContain('must be of type');
    });

    test('enforces maxLength on strings', () => {
      const params = { name: 'a'.repeat(50), email: 'test@example.com' };
      const schema = {
        name: { type: 'string', required: true, maxLength: 20 },
        email: { type: 'string', required: true },
      };
      const result = validateParameters(params, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.name).toContain('exceeds maximum length');
    });

    test('allows optional fields to be empty', () => {
      const params = { name: 'John' };
      const schema = {
        name: { type: 'string', required: true },
        bio: { type: 'string', required: false },
      };
      const result = validateParameters(params, schema);
      expect(result.valid).toBe(true);
    });
  });

  describe('LENGTH_LIMITS', () => {
    test('exports expected length limits', () => {
      expect(LENGTH_LIMITS.name).toBe(200);
      expect(LENGTH_LIMITS.email).toBe(254);
      expect(LENGTH_LIMITS.phone).toBe(20);
      expect(LENGTH_LIMITS.url).toBe(2048);
      expect(LENGTH_LIMITS.text).toBe(5000);
      expect(LENGTH_LIMITS.message).toBe(2000);
      expect(LENGTH_LIMITS.summary).toBe(1000);
    });
  });
});
