/**
 * Tests for websocket.js
 * Tests WebSocket server initialization, broadcasting, and client management
 */

const { initWebSocket, broadcast, getConnectionCount } = require('../utils/websocket');

jest.mock('ws');

describe('websocket', () => {
  let mockWss;
  let mockServer;
  let mockClient1;
  let mockClient2;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock WebSocket clients
    mockClient1 = {
      readyState: 1, // OPEN
      send: jest.fn(),
      ping: jest.fn(),
      on: jest.fn(),
      once: jest.fn()
    };

    mockClient2 = {
      readyState: 1, // OPEN
      send: jest.fn(),
      ping: jest.fn(),
      on: jest.fn(),
      once: jest.fn()
    };

    // Mock WebSocket.Server
    mockWss = {
      on: jest.fn((event, callback) => {
        if (event === 'connection') {
          mockWss.connectionCallback = callback;
        }
      })
    };

    mockServer = {
      listen: jest.fn()
    };

    const WebSocket = require('ws');
    WebSocket.Server = jest.fn(() => mockWss);
    WebSocket.OPEN = 1;
  });

  describe('initWebSocket', () => {
    test('initializes WebSocket server on provided HTTP server', () => {
      initWebSocket(mockServer);

      const WebSocket = require('ws');
      expect(WebSocket.Server).toHaveBeenCalledWith({
        server: mockServer,
        path: '/ws'
      });
    });

    test('registers connection event handler', () => {
      initWebSocket(mockServer);

      expect(mockWss.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    test('handles client connection', () => {
      initWebSocket(mockServer);

      const mockReq = {
        url: '/ws?api_key=test123'
      };

      mockWss.connectionCallback(mockClient1, mockReq);

      expect(getConnectionCount()).toBe(1);
    });

    test('sends initial ping on connection', () => {
      initWebSocket(mockServer);

      const mockReq = {
        url: '/ws?api_key=test123'
      };

      mockWss.connectionCallback(mockClient1, mockReq);

      expect(mockClient1.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"connected"')
      );
    });

    test('handles multiple client connections', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });
      mockWss.connectionCallback(mockClient2, { url: '/ws' });

      expect(getConnectionCount()).toBe(2);
    });
  });

  describe('broadcast', () => {
    test('sends message to all connected clients', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });
      mockWss.connectionCallback(mockClient2, { url: '/ws' });

      broadcast('test_event', { data: 'test' });

      expect(mockClient1.send).toHaveBeenCalled();
      expect(mockClient2.send).toHaveBeenCalled();
    });

    test('includes event type in broadcast message', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });

      broadcast('call_update', { status: 'completed' });

      const message = JSON.parse(mockClient1.send.mock.calls[1][0]);
      expect(message.type).toBe('call_update');
    });

    test('includes data in broadcast message', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });

      const testData = { callId: '123', status: 'completed' };
      broadcast('call_update', testData);

      const message = JSON.parse(mockClient1.send.mock.calls[1][0]);
      expect(message.data).toEqual(testData);
    });

    test('includes timestamp in broadcast message', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });

      broadcast('test_event', {});

      const message = JSON.parse(mockClient1.send.mock.calls[1][0]);
      expect(message.timestamp).toBeDefined();
    });

    test('handles client that fails to send gracefully', () => {
      initWebSocket(mockServer);

      mockClient1.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      mockWss.connectionCallback(mockClient1, { url: '/ws' });
      mockWss.connectionCallback(mockClient2, { url: '/ws' });

      broadcast('test_event', {});

      expect(mockClient2.send).toHaveBeenCalled();
    });

    test('does not send to closed clients', () => {
      initWebSocket(mockServer);

      mockClient1.readyState = 3; // CLOSED
      mockWss.connectionCallback(mockClient1, { url: '/ws' });

      broadcast('test_event', {});

      expect(mockClient1.send).not.toHaveBeenCalled();
    });

    test('returns early if no clients connected', () => {
      initWebSocket(mockServer);

      expect(() => broadcast('test_event', {})).not.toThrow();
    });
  });

  describe('getConnectionCount', () => {
    test('returns 0 when no clients connected', () => {
      initWebSocket(mockServer);

      expect(getConnectionCount()).toBe(0);
    });

    test('returns correct count after client connects', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });

      expect(getConnectionCount()).toBe(1);
    });

    test('returns correct count with multiple clients', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });
      mockWss.connectionCallback(mockClient2, { url: '/ws' });

      expect(getConnectionCount()).toBe(2);
    });

    test('decrements count when client disconnects', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });
      mockWss.connectionCallback(mockClient2, { url: '/ws' });

      expect(getConnectionCount()).toBe(2);

      // Simulate disconnect
      const closeCallback = mockClient1.on.mock.calls.find(call => call[0] === 'close')?.[1];
      if (closeCallback) {
        closeCallback();
      }

      expect(getConnectionCount()).toBe(1);
    });

    test('handles client error by removing from connections', () => {
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });

      const errorCallback = mockClient1.on.mock.calls.find(call => call[0] === 'error')?.[1];
      if (errorCallback) {
        errorCallback(new Error('Test error'));
      }

      expect(getConnectionCount()).toBe(0);
    });
  });

  describe('heartbeat', () => {
    test('sends heartbeat ping to all clients periodically', () => {
      jest.useFakeTimers();
      initWebSocket(mockServer);

      mockWss.connectionCallback(mockClient1, { url: '/ws' });

      jest.advanceTimersByTime(30000);

      expect(mockClient1.ping).toHaveBeenCalled();

      jest.useRealTimers();
    });

    test('removes closed clients during heartbeat', () => {
      jest.useFakeTimers();
      initWebSocket(mockServer);

      mockClient1.readyState = 3; // CLOSED
      mockWss.connectionCallback(mockClient1, { url: '/ws' });
      mockWss.connectionCallback(mockClient2, { url: '/ws' });

      expect(getConnectionCount()).toBe(2);

      jest.advanceTimersByTime(30000);

      expect(getConnectionCount()).toBe(1);

      jest.useRealTimers();
    });
  });

  describe('error handling', () => {
    test('handles initialization errors gracefully', () => {
      const WebSocket = require('ws');
      WebSocket.Server.mockImplementation(() => {
        throw new Error('WebSocket init failed');
      });

      expect(() => initWebSocket(mockServer)).not.toThrow();
    });

    test('logs warnings on init failure', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const WebSocket = require('ws');
      WebSocket.Server.mockImplementation(() => {
        throw new Error('WebSocket init failed');
      });

      initWebSocket(mockServer);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
