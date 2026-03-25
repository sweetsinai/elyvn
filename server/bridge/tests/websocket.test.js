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
      init(mockServer);

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

      init({});

      expect(mockWss.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    test('handles initialization errors gracefully', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');
      WebSocket.Server = jest.fn(() => {
        throw new Error('WebSocket init failed');
      });

      expect(() => init({})).not.toThrow();
    });
  });

  describe('broadcast', () => {
    test('sends message with correct structure', () => {
      const { broadcast: bc } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockClient = {
        readyState: 1,
        send: jest.fn()
      };

      const mockWss = {
        on: jest.fn((event, callback) => {
          if (event === 'connection') {
            callback(mockClient, { url: '/ws' });
          }
        })
      };

      WebSocket.Server = jest.fn(() => mockWss);
      WebSocket.OPEN = 1;

      const { initWebSocket: init } = require('../utils/websocket');
      init({});

      bc('test_event', { data: 'test' });

      expect(mockClient.send).toHaveBeenCalled();
      const message = JSON.parse(mockClient.send.mock.calls[0][0]);
      expect(message.type).toBe('test_event');
      expect(message.data).toEqual({ data: 'test' });
      expect(message.timestamp).toBeDefined();
    });

    test('handles broadcast without clients gracefully', () => {
      const { broadcast: bc } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      WebSocket.Server = jest.fn(() => mockWss);

      const { initWebSocket: init } = require('../utils/websocket');
      init({});

      expect(() => bc('test_event', {})).not.toThrow();
    });

    test('handles clients with different readyState values', () => {
      const { broadcast: bc, getConnectionCount: count } = require('../utils/websocket');
      const WebSocket = require('ws');

      const openClient = { readyState: 1, send: jest.fn(), on: jest.fn(), once: jest.fn() };
      const closedClient = { readyState: 3, send: jest.fn(), on: jest.fn(), once: jest.fn() };

      let connectionCallback;
      const mockWss = {
        on: jest.fn((event, callback) => {
          if (event === 'connection') {
            connectionCallback = callback;
          }
        })
      };

      WebSocket.Server = jest.fn(() => mockWss);
      WebSocket.OPEN = 1;

      const { initWebSocket: init } = require('../utils/websocket');
      init({});

      connectionCallback(openClient, { url: '/ws' });
      connectionCallback(closedClient, { url: '/ws' });

      bc('test_event', {});

      expect(openClient.send).toHaveBeenCalled();
    });

    test('handles client.send errors gracefully', () => {
      const { broadcast: bc } = require('../utils/websocket');
      const WebSocket = require('ws');

      const clientWithError = {
        readyState: 1,
        send: jest.fn(() => {
          throw new Error('Send failed');
        }),
        on: jest.fn(),
        once: jest.fn()
      };

      let connectionCallback;
      const mockWss = {
        on: jest.fn((event, callback) => {
          if (event === 'connection') {
            connectionCallback = callback;
          }
        })
      };

      WebSocket.Server = jest.fn(() => mockWss);
      WebSocket.OPEN = 1;

      const { initWebSocket: init } = require('../utils/websocket');
      init({});

      connectionCallback(clientWithError, { url: '/ws' });

      expect(() => bc('test_event', {})).not.toThrow();
    });
  });

  describe('getConnectionCount', () => {
    test('returns number of connections', () => {
      const { getConnectionCount: count, initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockClient = {
        readyState: 1,
        send: jest.fn(),
        on: jest.fn()
      };

      let connectionCallback;
      const mockWss = {
        on: jest.fn((event, callback) => {
          if (event === 'connection') {
            connectionCallback = callback;
          }
        })
      };

      WebSocket.Server = jest.fn(() => mockWss);
      WebSocket.OPEN = 1;

      init({});

      const initialCount = count();
      expect(typeof initialCount).toBe('number');
    });
  });

  describe('heartbeat', () => {
    test('sends ping to open connections', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockClient = {
        readyState: 1,
        ping: jest.fn(),
        send: jest.fn(),
        on: jest.fn()
      };

      let connectionCallback;
      const mockWss = {
        on: jest.fn((event, callback) => {
          if (event === 'connection') {
            connectionCallback = callback;
          }
        })
      };

      WebSocket.Server = jest.fn(() => mockWss);
      WebSocket.OPEN = 1;

      init({});

      connectionCallback(mockClient, { url: '/ws' });

      jest.useFakeTimers();
      jest.advanceTimersByTime(30000);
      jest.useRealTimers();

      expect(mockClient.ping).toHaveBeenCalled();
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

      expect(() => init({})).not.toThrow();

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
  });
});
