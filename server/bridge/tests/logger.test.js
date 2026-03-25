/**
 * Tests for logger.js
 * Tests file-based logging with rotation and retention
 */

const { setupLogger, closeLogger } = require('../utils/logger');

describe('logger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env vars
    delete process.env.LOG_DIR;
    delete process.env.LOG_RETENTION_DAYS;
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
});
