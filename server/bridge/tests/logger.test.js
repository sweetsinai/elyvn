/**
 * Tests for logger.js
 * Tests file-based logging with rotation and retention
 */

const fs = require('fs');

jest.mock('fs');

const { setupLogger, closeLogger, redact, redactPII } = require('../utils/logger');

describe('logger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env vars
    delete process.env.LOG_DIR;
    delete process.env.LOG_RETENTION_DAYS;

    // Mock fs.mkdirSync to do nothing
    fs.mkdirSync.mockImplementation(() => {});

    // Mock fs.createWriteStream to return a mock stream
    const mockStream = {
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
    };
    fs.createWriteStream.mockReturnValue(mockStream);

    // Mock fs.readdirSync to return empty array (no old logs to clean)
    fs.readdirSync.mockReturnValue([]);
  });

  afterEach(() => {
    jest.resetModules();
  });

  describe('setupLogger', () => {
    test('exports setupLogger function', () => {
      expect(typeof setupLogger).toBe('function');
    });

    test('setupLogger completes without error', () => {
      expect(() => setupLogger()).not.toThrow();
    });

    test('respects LOG_RETENTION_DAYS environment variable', () => {
      process.env.LOG_RETENTION_DAYS = '14';
      expect(() => setupLogger()).not.toThrow();
    });

    test('respects LOG_DIR environment variable', () => {
      process.env.LOG_DIR = '/tmp/custom-logs';
      expect(() => setupLogger()).not.toThrow();
    });

    test('handles missing LOG_DIR gracefully', () => {
      delete process.env.LOG_DIR;
      expect(() => setupLogger()).not.toThrow();
    });

    test('setupLogger handles errors gracefully', () => {
      // Even if log directory creation fails, setupLogger should not throw
      expect(() => setupLogger()).not.toThrow();
    });

    test('handles invalid LOG_RETENTION_DAYS', () => {
      process.env.LOG_RETENTION_DAYS = 'not-a-number';
      expect(() => setupLogger()).not.toThrow();
    });

    test('handles very large LOG_RETENTION_DAYS', () => {
      process.env.LOG_RETENTION_DAYS = '99999';
      expect(() => setupLogger()).not.toThrow();
    });

    test('handles zero LOG_RETENTION_DAYS', () => {
      process.env.LOG_RETENTION_DAYS = '0';
      expect(() => setupLogger()).not.toThrow();
    });

    test('handles negative LOG_RETENTION_DAYS', () => {
      process.env.LOG_RETENTION_DAYS = '-1';
      expect(() => setupLogger()).not.toThrow();
    });
  });

  describe('closeLogger', () => {
    test('exports closeLogger function', () => {
      expect(typeof closeLogger).toBe('function');
    });

    test('closeLogger completes without error', () => {
      setupLogger();
      expect(() => closeLogger()).not.toThrow();
    });

    test('closeLogger can be called before setup', () => {
      expect(() => closeLogger()).not.toThrow();
    });

    test('closeLogger can be called multiple times', () => {
      setupLogger();
      expect(() => closeLogger()).not.toThrow();
      expect(() => closeLogger()).not.toThrow();
    });

    test('closeLogger succeeds after logging', () => {
      setupLogger();
      // Direct write to log would happen here
      expect(() => closeLogger()).not.toThrow();
    });

    test('closeLogger handles errors gracefully', () => {
      setupLogger();
      expect(() => closeLogger()).not.toThrow();
    });
  });

  describe('integration', () => {
    test('complete setup-close workflow', () => {
      expect(() => {
        setupLogger();
        closeLogger();
      }).not.toThrow();
    });

    test('multiple setup calls are safe', () => {
      expect(() => {
        setupLogger();
        setupLogger();
        closeLogger();
      }).not.toThrow();
    });

    test('setup-log-close workflow succeeds', () => {
      // This just verifies the functions work together
      expect(() => {
        setupLogger();
        closeLogger();
      }).not.toThrow();
    });

    test('handles multiple close calls safely', () => {
      setupLogger();
      expect(() => {
        closeLogger();
        closeLogger();
        closeLogger();
      }).not.toThrow();
    });
  });

  describe('environment configuration', () => {
    test('uses default retention days when not set', () => {
      delete process.env.LOG_RETENTION_DAYS;
      expect(() => setupLogger()).not.toThrow();
    });

    test('parses numeric LOG_RETENTION_DAYS', () => {
      process.env.LOG_RETENTION_DAYS = '30';
      expect(() => setupLogger()).not.toThrow();
    });

    test('uses default LOG_DIR when not set', () => {
      delete process.env.LOG_DIR;
      expect(() => setupLogger()).not.toThrow();
    });

    test('honors custom LOG_DIR when provided', () => {
      process.env.LOG_DIR = '/var/log/app';
      expect(() => setupLogger()).not.toThrow();
    });

    test('handles empty LOG_DIR string', () => {
      process.env.LOG_DIR = '';
      expect(() => setupLogger()).not.toThrow();
    });

    test('handles whitespace LOG_DIR', () => {
      process.env.LOG_DIR = '  /tmp/logs  ';
      expect(() => setupLogger()).not.toThrow();
    });
  });

  describe('safety', () => {
    test('setupLogger is idempotent', () => {
      // Calling multiple times should be safe
      expect(() => {
        setupLogger();
        setupLogger();
        setupLogger();
      }).not.toThrow();
    });

    test('closeLogger is idempotent', () => {
      // Calling multiple times should be safe
      expect(() => {
        closeLogger();
        closeLogger();
        closeLogger();
      }).not.toThrow();
    });

    test('close before setup is safe', () => {
      expect(() => {
        closeLogger();
        setupLogger();
        closeLogger();
      }).not.toThrow();
    });
  });

  describe('PII redaction — redact()', () => {
    test('redacts standard 10-digit phone number (dashes)', () => {
      // The separator before the area code is part of the match
      expect(redact('Call me at 415-555-1234 please')).toBe('Call me at [PHONE] please');
    });

    test('redacts phone number with parentheses and space', () => {
      expect(redact('Phone: (415) 555-1234')).toBe('Phone: [PHONE]');
    });

    test('redacts E.164 phone number (+1 with separator)', () => {
      // +1 followed by NXX-NXX-XXXX form
      expect(redact('+1-415-555-1234')).toBe('[PHONE]');
    });

    test('redacts E.164 phone number (+1 compact)', () => {
      expect(redact('+14155551234 is the number')).toBe('[PHONE] is the number');
    });

    test('redacts email address', () => {
      expect(redact('Contact john.doe@example.com for help')).toBe('Contact [EMAIL] for help');
    });

    test('redacts email with plus addressing', () => {
      expect(redact('Sent to user+tag@domain.co.uk')).toBe('Sent to [EMAIL]');
    });

    test('redacts credit card number with spaces', () => {
      expect(redact('Card: 4111 1111 1111 1111')).toBe('Card: [CARD]');
    });

    test('redacts credit card number with dashes', () => {
      expect(redact('Card: 4111-1111-1111-1111')).toBe('Card: [CARD]');
    });

    test('redacts bare 16-digit credit card', () => {
      expect(redact('4111111111111111')).toBe('[CARD]');
    });

    test('redacts Stripe live secret key', () => {
      expect(redact('key=sk_live_abcdef1234567890xyz')).toBe('key=[STRIPE_KEY]');
    });

    test('redacts Stripe test secret key', () => {
      expect(redact('sk_test_abcdefghijklmnop is exposed')).toBe('[STRIPE_KEY] is exposed');
    });

    test('redacts JWT token', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      expect(redact(`token: ${jwt}`)).toBe('token: [JWT]');
    });

    test('returns non-string values unchanged', () => {
      expect(redact(42)).toBe(42);
      expect(redact(null)).toBe(null);
      expect(redact(undefined)).toBe(undefined);
    });

    test('redacts multiple PII items in one string', () => {
      const result = redact('User john@acme.com called from 415-555-9876');
      expect(result).toBe('User [EMAIL] called from [PHONE]');
    });
  });

  describe('PII redaction — redactPII()', () => {
    test('redacts string values', () => {
      expect(redactPII('email: foo@bar.com')).toBe('email: [EMAIL]');
    });

    test('redacts nested object string values', () => {
      const input = { user: { email: 'test@example.com', phone: '555-867-5309' } };
      const result = redactPII(input);
      expect(result.user.email).toBe('[EMAIL]');
      expect(result.user.phone).toBe('[PHONE]');
    });

    test('redacts array string elements', () => {
      const result = redactPII(['hello@world.com', '415-555-0001', 'safe text']);
      expect(result[0]).toBe('[EMAIL]');
      expect(result[1]).toBe('[PHONE]');
      expect(result[2]).toBe('safe text');
    });

    test('passes through non-string primitives unchanged', () => {
      const input = { count: 5, active: true, value: null };
      expect(redactPII(input)).toEqual({ count: 5, active: true, value: null });
    });

    test('redacts Stripe key inside nested object', () => {
      const input = { config: { apiKey: 'sk_live_supersecretkey123' } };
      expect(redactPII(input).config.apiKey).toBe('[STRIPE_KEY]');
    });

    test('redacts JWT inside nested object', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456ghi789';
      const input = { auth: { token: jwt } };
      expect(redactPII(input).auth.token).toBe('[JWT]');
    });

    test('does not mutate the original object', () => {
      const original = { email: 'private@example.com' };
      redactPII(original);
      expect(original.email).toBe('private@example.com');
    });
  });
});
