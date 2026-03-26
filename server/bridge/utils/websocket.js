/**
const { WEBSOCKET_HEARTBEAT_INTERVAL_MS } = require('../config/timing');
 * WebSocket Manager — real-time updates to dashboard
 * Uses the 'ws' package (already a dependency)
 */

const WebSocket = require('ws');

let wss = null;
const clients = new Set();

function initWebSocket(server) {
  try {
    wss = new WebSocket.Server({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
      // Basic auth check via query param (optional for now)
      const url = new URL(req.url, 'http://localhost');
      const apiKey = url.searchParams.get('api_key');

      clients.add(ws);
      console.log(`[ws] Client connected (${clients.size} total)`);

      ws.on('close', () => {
        clients.delete(ws);
        console.log(`[ws] Client disconnected (${clients.size} total)`);
      });

      ws.on('error', (err) => {
        console.error('[ws] Client error:', err.message);
        clients.delete(ws);
      });

      // Send initial ping
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    });

    // Heartbeat every 30s
    setInterval(() => {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        } else {
          clients.delete(client);
        }
      }
    }, WEBSOCKET_HEARTBEAT_INTERVAL_MS);

    console.log('[ws] WebSocket server initialized on /ws');
  } catch (err) {
    console.warn('[ws] WebSocket init failed:', err.message);
  }
}

function broadcast(event, data) {
  if (!wss || clients.size === 0) return;

  const message = JSON.stringify({ type: event, data, timestamp: new Date().toISOString() });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        clients.delete(client);
      }
    }
  }
}

function getConnectionCount() {
  return clients.size;
}

module.exports = { initWebSocket, broadcast, getConnectionCount };
