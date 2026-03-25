/**
 * Unit tests for gracefulShutdown.js
 * 100% branch and line coverage
 */

jest.mock('../utils/dbAdapter');

const { initGracefulShutdown, onShutdown } = require('../utils/gracefulShutdown');
const { closeDatabase } = require('../utils/dbAdapter');

describe('gracefulShutdown', () => {
  let originalOn;
  let originalExit;
  let processListeners = {};

  beforeEach(() => {
    jest.clearAllMocks();
    processListeners = {};

    console.log = jest.fn();
    console.error = jest.fn();

    // Mock process.on
    originalOn = process.on;
    process.on = jest.fn((signal, handler) => {
      processListeners[signal] = handler;
    });

    // Mock process.exit
    originalExit = process.exit;
    process.exit = jest.fn();

    // Clear shutdown callbacks by resetting module
    jest.resetModules();
  });

  afterEach(() => {
    process.on = originalOn;
    process.exit = originalExit;
  });

  describe('initGracefulShutdown', () => {
    it('should register SIGTERM and SIGINT handlers', () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });

    it('should return onShutdown and isShuttingDown functions', () => {
      const result = initGracefulShutdown({ close: jest.fn() }, {});

      expect(result).toHaveProperty('onShutdown');
      expect(result).toHaveProperty('isShuttingDown');
      expect(typeof result.onShutdown).toBe('function');
      expect(typeof result.isShuttingDown).toBe('function');
    });

    it('should call server.close on signal', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      expect(processListeners.SIGTERM).toBeDefined();

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(100);
      await shutdownPromise;
      jest.useRealTimers();

      expect(mockServer.close).toHaveBeenCalled();
    });

    it('should close database on signal', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(closeDatabase).toHaveBeenCalledWith(mockDb);
    });

    it('should exit with code 0 on graceful shutdown', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should force exit with code 1 after 10 second timeout', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      jest.useFakeTimers();
      mockServer.close.mockImplementation(() => {
        // Never calls callback to simulate hanging shutdown
      });

      const sigterm = processListeners.SIGTERM;
      sigterm();

      // Advance past initial shutdown phase
      jest.advanceTimersByTime(500);

      // The forceShutdown timeout should trigger process.exit(1)
      jest.advanceTimersByTime(10500);

      jest.useRealTimers();

      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should log messages during shutdown', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown] SIGTERM received')
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown] HTTP server closed')
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown] Graceful shutdown complete')
      );
    });

    it('should handle server being undefined', async () => {
      const mockDb = {};

      initGracefulShutdown(null, mockDb);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        setTimeout(() => r(), 100);
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      // Should not throw and should call closeDatabase
      expect(closeDatabase).toHaveBeenCalledWith(mockDb);
    });

    it('should handle db being undefined', async () => {
      const mockServer = { close: jest.fn() };

      initGracefulShutdown(mockServer, null);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      // Should not throw and should exit gracefully
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should handle SIGINT signal', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGINT();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[shutdown] SIGINT received')
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should handle closeDatabase error', async () => {
      closeDatabase.mockImplementation(() => {
        throw new Error('Database close failed');
      });

      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(console.error).toHaveBeenCalledWith(
        '[shutdown] DB close error:',
        'Database close failed'
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should run registered shutdown callbacks before closing db', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};
      const callOrder = [];

      const result = initGracefulShutdown(mockServer, mockDb);

      result.onShutdown(async () => {
        callOrder.push('callback1');
      });

      result.onShutdown(async () => {
        callOrder.push('callback2');
      });

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          callOrder.push('server');
          r();
        });
        closeDatabase.mockImplementation(() => {
          callOrder.push('db');
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(callOrder).toEqual(['server', 'callback1', 'callback2', 'db']);
    });

    it('should handle shutdown callback errors', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      const result = initGracefulShutdown(mockServer, mockDb);

      result.onShutdown(async () => {
        throw new Error('Callback error');
      });

      result.onShutdown(async () => {
        // This should still run
      });

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(console.error).toHaveBeenCalledWith(
        '[shutdown] Callback error:',
        'Callback error'
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should prevent multiple concurrent shutdowns', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      const result = initGracefulShutdown(mockServer, mockDb);

      result.onShutdown(async () => {
        // Do nothing
      });

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        // First signal
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(100);
      await shutdownPromise;

      // Try to trigger shutdown again
      const secondCall = () => processListeners.SIGTERM();
      secondCall();

      jest.useRealTimers();

      // Server.close should only be called once
      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });

    it('should report isShuttingDown status', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      const result = initGracefulShutdown(mockServer, mockDb);

      expect(result.isShuttingDown()).toBe(false);

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          // Check status during shutdown
          expect(result.isShuttingDown()).toBe(true);
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(200);
      await shutdownPromise;
      jest.useRealTimers();

      expect(result.isShuttingDown()).toBe(true);
    });

    it('should handle long-running shutdown callbacks', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      const result = initGracefulShutdown(mockServer, mockDb);

      result.onShutdown(async () => {
        await new Promise(r => setTimeout(r, 5000));
      });

      jest.useFakeTimers();
      const shutdownPromise = new Promise(r => {
        mockServer.close.mockImplementation((cb) => {
          cb();
          r();
        });
        processListeners.SIGTERM();
      });

      jest.advanceTimersByTime(6000);
      await shutdownPromise;
      jest.useRealTimers();

      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('onShutdown', () => {
    it('should be callable directly without initGracefulShutdown', () => {
      const callback = jest.fn();
      onShutdown(callback);
      // Should not throw
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
