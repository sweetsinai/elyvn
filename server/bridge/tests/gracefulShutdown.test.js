/**
 * Unit tests for gracefulShutdown.js
 * 100% branch and line coverage
 */

jest.mock('../utils/dbAdapter');

// Require after mock setup
let initGracefulShutdown;
let onShutdown;
let closeDatabase;

// Track process listeners
const processListeners = {};
const originalOn = process.on;
const originalExit = process.exit;

process.on = jest.fn((signal, handler) => {
  processListeners[signal] = handler;
});
process.exit = jest.fn();

describe('gracefulShutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(processListeners).forEach(key => delete processListeners[key]);

    console.log = jest.fn();
    console.error = jest.fn();

    // Load fresh module for each test
    jest.resetModules();
    closeDatabase = require('../utils/dbAdapter').closeDatabase;
    const gracefulShutdown = require('../utils/gracefulShutdown');
    initGracefulShutdown = gracefulShutdown.initGracefulShutdown;
    onShutdown = gracefulShutdown.onShutdown;
  });

  afterEach(() => {
    jest.clearAllMocks();
    Object.keys(processListeners).forEach(key => delete processListeners[key]);
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

      mockServer.close.mockImplementation((cb) => {
        cb();
      });
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      expect(mockServer.close).toHaveBeenCalled();
    });

    it('should close database on signal', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      mockServer.close.mockImplementation((cb) => {
        cb();
      });
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      expect(closeDatabase).toHaveBeenCalledWith(mockDb);
    });

    it('should exit with code 0 on graceful shutdown', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      mockServer.close.mockImplementation((cb) => {
        cb();
      });
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should log messages during shutdown', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      mockServer.close.mockImplementation((cb) => {
        cb();
      });
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

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

      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      expect(closeDatabase).toHaveBeenCalledWith(mockDb);
    });

    it('should handle db being undefined', async () => {
      const mockServer = { close: jest.fn() };

      initGracefulShutdown(mockServer, null);

      mockServer.close.mockImplementation((cb) => {
        cb();
      });
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should handle SIGINT signal', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      initGracefulShutdown(mockServer, mockDb);

      mockServer.close.mockImplementation((cb) => {
        cb();
      });
      processListeners.SIGINT();

      await new Promise(r => setTimeout(r, 50));

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

      mockServer.close.mockImplementation((cb) => {
        cb();
      });
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

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

      mockServer.close.mockImplementation((cb) => {
        callOrder.push('server');
        cb();
      });
      closeDatabase.mockImplementation(() => {
        callOrder.push('db');
      });

      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 100));

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

      mockServer.close.mockImplementation((cb) => {
        cb();
      });

      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 100));

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

      mockServer.close.mockImplementation((cb) => {
        cb();
      });

      // First signal
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      // Try to trigger shutdown again
      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      // Server.close should only be called once
      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });

    it('should report isShuttingDown status', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      const result = initGracefulShutdown(mockServer, mockDb);

      expect(result.isShuttingDown()).toBe(false);

      let statusDuringShutdown = false;
      mockServer.close.mockImplementation((cb) => {
        statusDuringShutdown = result.isShuttingDown();
        cb();
      });

      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 50));

      expect(statusDuringShutdown).toBe(true);
      expect(result.isShuttingDown()).toBe(true);
    });

    it('should handle long-running shutdown callbacks', async () => {
      const mockServer = { close: jest.fn() };
      const mockDb = {};

      const result = initGracefulShutdown(mockServer, mockDb);

      result.onShutdown(async () => {
        await new Promise(r => setTimeout(r, 100));
      });

      mockServer.close.mockImplementation((cb) => {
        cb();
      });

      processListeners.SIGTERM();

      await new Promise(r => setTimeout(r, 200));

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
