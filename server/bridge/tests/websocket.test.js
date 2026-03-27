/**
 * Tests for websocket.js
 * Tests WebSocket server initialization, broadcasting, and client management
 */

const { initWebSocket, broadcast, getConnectionCount } = require('../utils/websocket');

jest.mock('ws');

describe('websocket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('initWebSocket', () => {
    test('initializes WebSocket server with correct path', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');
      const mockWss = { on: jest.fn() };
      WebSocket.Server = jest.fn(() => mockWss);

      const mockServer = {};
      const mockDb = {};
      init(mockServer, mockDb);

      expect(WebSocket.Server).toHaveBeenCalledWith({
        server: mockServer,
        path: '/ws'
      });
    });

    test('registers connection event handler', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');
      const mockWss = { on: jest.fn() };
      WebSocket.Server = jest.fn(() => mockWss);

      init({}, {});

      expect(mockWss.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    test('handles initialization errors gracefully', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');
      WebSocket.Server = jest.fn(() => {
        throw new Error('WebSocket init failed');
      });

      expect(() => init({}, {})).not.toThrow();
    });
  });

  describe('broadcast', () => {
    test('handles broadcast without authenticated clients gracefully', () => {
      const { broadcast: bc } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      WebSocket.Server = jest.fn(() => mockWss);

      const { initWebSocket: init } = require('../utils/websocket');
      init({}, {});

      expect(() => bc('test_event', {})).not.toThrow();
    });
  });

  describe('getConnectionCount', () => {
    test('returns number of connections', () => {
      const { getConnectionCount: count, initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      WebSocket.Server = jest.fn(() => mockWss);
      WebSocket.OPEN = 1;

      init({}, {});

      const initialCount = count();
      expect(typeof initialCount).toBe('number');
      expect(initialCount).toBe(0);
    });
  });

  describe('heartbeat', () => {
    test('heartbeat timer is established without errors', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      WebSocket.Server = jest.fn(() => mockWss);
      WebSocket.OPEN = 1;

      jest.useFakeTimers();
      init({}, {});
      // Advance past heartbeat interval — should not throw
      jest.advanceTimersByTime(31000);
      jest.useRealTimers();

      expect(true).toBe(true);
    });
  });

  describe('error handling', () => {
    test('gracefully handles WebSocket initialization errors', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      WebSocket.Server = jest.fn(() => {
        throw new Error('Port in use');
      });

      expect(() => init({}, {})).not.toThrow();

      consoleSpy.mockRestore();
    });
  });

  describe('module exports', () => {
    test('exports initWebSocket function', () => {
      const { initWebSocket } = require('../utils/websocket');
      expect(typeof initWebSocket).toBe('function');
    });

    test('exports broadcast function', () => {
      const { broadcast } = require('../utils/websocket');
      expect(typeof broadcast).toBe('function');
    });

    test('exports getConnectionCount function', () => {
      const { getConnectionCount } = require('../utils/websocket');
      expect(typeof getConnectionCount).toBe('function');
    });

    test('exports cleanupWebSocket function', () => {
      const { cleanupWebSocket } = require('../utils/websocket');
      expect(typeof cleanupWebSocket).toBe('function');
    });
  });
});
