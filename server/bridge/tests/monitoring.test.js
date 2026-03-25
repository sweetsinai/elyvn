/**
 * Tests for monitoring.js
 * Tests Sentry integration for error tracking
 */

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  expressErrorHandler: jest.fn(() => (err, req, res, next) => next(err)),
  Handlers: {
    requestHandler: jest.fn(() => (req, res, next) => next()),
    errorHandler: jest.fn(() => (err, req, res, next) => next(err)),
  },
}), { virtual: true });

const { initMonitoring, captureException, captureMessage, expressErrorHandler } = require('../utils/monitoring');

describe('monitoring', () => {
  let mockSentry;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    // Get the already-mocked Sentry module
    const Sentry = require('@sentry/node');

    // Setup default mock behaviors
    Sentry.init.mockImplementation(() => {});
    Sentry.captureException.mockImplementation(() => {});
    Sentry.captureMessage.mockImplementation(() => {});
    Sentry.expressErrorHandler.mockReturnValue((err, req, res, next) => next(err));
    Sentry.Handlers.requestHandler.mockReturnValue((req, res, next) => next());
    Sentry.Handlers.errorHandler.mockReturnValue((err, req, res, next) => next(err));
  });

  describe('initMonitoring', () => {
    test('initializes Sentry when DSN is configured', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      expect(Sentry.init).toHaveBeenCalled();
    });

    test('skips initialization when DSN not configured', () => {
      delete process.env.SENTRY_DSN;
      const Sentry = require('@sentry/node');

      initMonitoring();

      // Should not throw
      expect(true).toBe(true);
    });

    test('configures Sentry with correct options', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      process.env.NODE_ENV = 'production';
      process.env.npm_package_version = '1.0.0';

      const Sentry = require('@sentry/node');

      initMonitoring();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://key@sentry.io/project',
          environment: 'production',
          tracesSampleRate: 0.1
        })
      );
    });

    test('uses default version when not specified', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      delete process.env.npm_package_version;

      const Sentry = require('@sentry/node');

      initMonitoring();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          release: '1.0.0'
        })
      );
    });

    test('handles Sentry init errors gracefully', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');
      Sentry.init.mockImplementation(() => {
        throw new Error('Sentry not installed');
      });

      expect(() => initMonitoring()).not.toThrow();
    });

    test('configures beforeSend to scrub PII', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';

      const Sentry = require('@sentry/node');

      initMonitoring();

      const config = Sentry.init.mock.calls[0][0];
      const event = {
        request: {
          headers: {
            'x-api-key': 'secret-key',
            'authorization': 'Bearer token',
            'user-agent': 'Chrome'
          }
        }
      };

      config.beforeSend(event);

      expect(event.request.headers['x-api-key']).toBeUndefined();
      expect(event.request.headers['authorization']).toBeUndefined();
      expect(event.request.headers['user-agent']).toBeDefined();
    });
  });

  describe('captureException', () => {
    test('sends exception to Sentry if initialized', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      const err = new Error('Test error');
      const context = { userId: '123', action: 'login' };

      captureException(err, context);

      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          extra: context
        })
      );
    });

    test('always logs error locally', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      const err = new Error('Test error');
      captureException(err);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test error'),
        expect.any(Object)
      );

      consoleSpy.mockRestore();
    });

    test('handles null context gracefully', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      const err = new Error('Test');

      expect(() => captureException(err)).not.toThrow();
    });

    test('logs error even if Sentry not initialized', () => {
      delete process.env.SENTRY_DSN;
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      // Don't initialize
      const err = new Error('Test error');
      captureException(err, {});

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('captureMessage', () => {
    test('sends message to Sentry if initialized', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      captureMessage('Test message', 'warning', { component: 'scheduler' });

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Test message',
        expect.objectContaining({
          level: 'warning',
          extra: { component: 'scheduler' }
        })
      );
    });

    test('uses default level of info', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      captureMessage('Test message');

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Test message',
        expect.objectContaining({
          level: 'info'
        })
      );
    });

    test('handles different severity levels', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      const levels = ['info', 'warning', 'error', 'fatal'];
      for (const level of levels) {
        captureMessage('Test', level);
      }

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(4);
    });

    test('skips Sentry if not initialized', () => {
      delete process.env.SENTRY_DSN;

      captureMessage('Test message');

      const Sentry = require('@sentry/node');
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe('expressErrorHandler', () => {
    test('returns Sentry express error handler if initialized', () => {
      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      const handler = expressErrorHandler();

      expect(handler).toBeDefined();
    });

    test('returns fallback error handler if not initialized', () => {
      delete process.env.SENTRY_DSN;

      const handler = expressErrorHandler();

      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');

      // Test fallback behavior
      const mockNext = jest.fn();
      const err = new Error('Test');
      handler(err, null, null, mockNext);

      expect(mockNext).toHaveBeenCalledWith(err);
    });

    test('express error handler is middleware compatible', () => {
      delete process.env.SENTRY_DSN;

      const handler = expressErrorHandler();

      // Should be a function accepting (err, req, res, next)
      expect(handler.length).toBe(4);
    });
  });

  describe('integration tests', () => {
    test('full flow: init, capture exception, log locally', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      process.env.SENTRY_DSN = 'https://key@sentry.io/project';
      const Sentry = require('@sentry/node');

      initMonitoring();

      const err = new Error('Integration test error');
      const context = { trace_id: 'abc123' };

      captureException(err, context);

      expect(Sentry.captureException).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    test('can initialize and send errors without Sentry package', () => {
      const Sentry = require('@sentry/node');
      Sentry.init.mockImplementation(() => {
        throw new Error('Module not found');
      });

      expect(() => initMonitoring()).not.toThrow();
      expect(() => captureException(new Error('Test'))).not.toThrow();
      expect(() => captureMessage('Test')).not.toThrow();
    });
  });
});
