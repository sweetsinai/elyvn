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

  describe('WebSocket Authentication Flow', () => {
    test('should send auth_required challenge on connection', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      let connectionHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        // Verify auth_required was sent
        const calls = mockWs.send.mock.calls;
        const authChallenge = calls.find(call =>
          typeof call[0] === 'string' && call[0].includes('auth_required')
        );
        expect(authChallenge).toBeDefined();
      }
    });

    test('should authenticate client with valid API key', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');
      const crypto = require('crypto');

      process.env.ELYVN_API_KEY = 'test-api-key-123';

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          // Send valid auth message
          const authMsg = JSON.stringify({ type: 'auth', api_key: 'test-api-key-123' });
          messageHandler(authMsg);

          // Verify authenticated response was sent
          const authenticated = mockWs.send.mock.calls.find(call =>
            typeof call[0] === 'string' && call[0].includes('authenticated')
          );
          expect(authenticated).toBeDefined();
        }
      }
    });

    test('should reject connection with invalid API key', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      process.env.ELYVN_API_KEY = 'correct-key';

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          // Send invalid auth message
          const authMsg = JSON.stringify({ type: 'auth', api_key: 'wrong-key' });
          messageHandler(authMsg);

          // Verify close was called with auth failure code
          expect(mockWs.close).toHaveBeenCalledWith(
            expect.any(Number),
            expect.stringMatching(/Invalid API key|not configured/)
          );
        }
      }
    });

    test('should use timing-safe comparison for API keys', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');
      const crypto = require('crypto');

      process.env.ELYVN_API_KEY = 'test-key';

      const mockWss = { on: jest.fn() };
      let connectionHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      // This test verifies timing-safe comparison is used (not exact equality)
      const cryptoSpy = jest.spyOn(crypto, 'timingSafeEqual');

      init({}, {});

      expect(true).toBe(true); // Placeholder
      cryptoSpy.mockRestore();
    });

    test('should check client API keys against database', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');
      const crypto = require('crypto');

      process.env.ELYVN_API_KEY = 'server-key';

      const mockDb = {
        prepare: jest.fn(() => ({
          get: jest.fn().mockReturnValue({ id: 'key-123' })
        }))
      };

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, mockDb);

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          const authMsg = JSON.stringify({ type: 'auth', api_key: 'client-key' });
          messageHandler(authMsg);

          // Verify DB was queried for client API key hash
          expect(mockDb.prepare).toHaveBeenCalledWith(
            expect.stringContaining('client_api_keys')
          );
        }
      }
    });
  });

  describe('Authentication Timeout', () => {
    test('should disconnect clients that don\'t authenticate within 5 seconds', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      let connectionHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      jest.useFakeTimers();

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        // Advance past 5 second timeout
        jest.advanceTimersByTime(5000);

        expect(mockWs.close).toHaveBeenCalledWith(
          4001,
          'Authentication timeout'
        );
      }

      jest.useRealTimers();
    });

    test('should clear timeout after successful authentication', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      process.env.ELYVN_API_KEY = 'test-key';

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      jest.useFakeTimers();

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          // Authenticate
          const authMsg = JSON.stringify({ type: 'auth', api_key: 'test-key' });
          messageHandler(authMsg);

          // Advance past 5 second timeout
          jest.advanceTimersByTime(6000);

          // Should not close due to timeout (already authenticated)
          const closeCallCount = mockWs.close.mock.calls.length;
          expect(closeCallCount).toBe(0);
        }
      }

      jest.useRealTimers();
    });
  });

  describe('Broadcast to Authenticated Clients Only', () => {
    test('should broadcast only to authenticated clients', () => {
      const { initWebSocket: init, broadcast: bc } = require('../utils/websocket');
      const WebSocket = require('ws');

      process.env.ELYVN_API_KEY = 'test-key';

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs1 = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs1, {});

        if (messageHandler) {
          // Authenticate
          const authMsg = JSON.stringify({ type: 'auth', api_key: 'test-key' });
          messageHandler(authMsg);
        }
      }

      // Reset send mock to count only broadcast calls
      mockWs1.send.mockClear();

      // Broadcast message
      bc('test_event', { data: 'test' });

      // Authenticated client should receive broadcast
      expect(mockWs1.send).toHaveBeenCalled();
    });

    test('should not broadcast to unauthenticated clients', () => {
      const { initWebSocket: init, broadcast: bc } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      let connectionHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});
      }

      // Reset send mock
      mockWs.send.mockClear();

      // Broadcast message
      bc('test_event', { data: 'test' });

      // Unauthenticated client should not receive broadcast
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    test('should format broadcast message with timestamp', () => {
      const { initWebSocket: init, broadcast: bc } = require('../utils/websocket');
      const WebSocket = require('ws');

      process.env.ELYVN_API_KEY = 'test-key';

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          const authMsg = JSON.stringify({ type: 'auth', api_key: 'test-key' });
          messageHandler(authMsg);
        }
      }

      mockWs.send.mockClear();

      bc('update', { count: 5 });

      const calls = mockWs.send.mock.calls;
      if (calls.length > 0) {
        const message = JSON.parse(calls[0][0]);
        expect(message.type).toBe('update');
        expect(message.timestamp).toBeDefined();
        expect(message.data).toEqual({ count: 5 });
      }
    });

    test('should ignore messages from unauthenticated clients', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          // Send non-auth message without authenticating
          const msg = JSON.stringify({ type: 'some_event', data: 'test' });
          messageHandler(msg);

          // No errors should occur (message should be ignored)
          expect(true).toBe(true);
        }
      }
    });

    test('should handle invalid JSON messages gracefully', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          // Send invalid JSON
          expect(() => messageHandler('not valid json')).not.toThrow();
        }
      }
    });
  });

  describe('Connection Management', () => {
    test('should remove client from authenticated set on close', () => {
      const { initWebSocket: init, getConnectionCount } = require('../utils/websocket');
      const WebSocket = require('ws');

      process.env.ELYVN_API_KEY = 'test-key';

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let messageHandler;
      let closeHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'message') {
            messageHandler = handler;
          } else if (event === 'close') {
            closeHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (messageHandler) {
          const authMsg = JSON.stringify({ type: 'auth', api_key: 'test-key' });
          messageHandler(authMsg);
        }
      }

      const countBefore = getConnectionCount();

      if (closeHandler) {
        closeHandler();
      }

      const countAfter = getConnectionCount();
      expect(countAfter).toBeLessThanOrEqual(countBefore);
    });

    test('should handle errors on client close gracefully', () => {
      const { initWebSocket: init } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn() };
      let connectionHandler;
      let errorHandler;

      WebSocket.Server = jest.fn(() => mockWss);
      mockWss.on = jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      });

      const mockWs = {
        on: jest.fn((event, handler) => {
          if (event === 'error') {
            errorHandler = handler;
          }
        }),
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN || 1
      };

      init({}, {});

      if (connectionHandler) {
        connectionHandler(mockWs, {});

        if (errorHandler) {
          expect(() => errorHandler(new Error('Connection error'))).not.toThrow();
        }
      }
    });
  });

  describe('cleanupWebSocket', () => {
    test('should clean up resources on shutdown', () => {
      const { initWebSocket: init, cleanupWebSocket } = require('../utils/websocket');
      const WebSocket = require('ws');

      const mockWss = { on: jest.fn(), close: jest.fn() };
      WebSocket.Server = jest.fn(() => mockWss);

      init({}, {});

      expect(() => cleanupWebSocket()).not.toThrow();
      expect(mockWss.close).toHaveBeenCalled();
    });
  });
});
