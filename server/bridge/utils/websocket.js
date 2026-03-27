/**
 * WebSocket Manager — real-time updates to dashboard
 * Auth via first message (not query param) to avoid key leaking in URLs/logs
 */

const { WEBSOCKET_HEARTBEAT_INTERVAL_MS } = require('../config/timing');
const WebSocket = require('ws');
const crypto = require('crypto');

let wss = null;
const authenticatedClients = new Set();
let heartbeatInterval;

function initWebSocket(server, db) {
  try {
    wss = new WebSocket.Server({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
      let authenticated = false;
      let authTimeout = null;

      // Give client 5s to authenticate, otherwise disconnect
      authTimeout = setTimeout(() => {
        if (!authenticated) {
          ws.close(4001, 'Authentication timeout');
        }
      }, 5000);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);

          // Handle auth message
          if (msg.type === 'auth' && msg.api_key) {
            const API_KEY = process.env.ELYVN_API_KEY;
            if (!API_KEY) {
              ws.close(4002, 'Server not configured');
              return;
            }

            // Timing-safe comparison
            const provided = Buffer.from(String(msg.api_key));
            const expected = Buffer.from(String(API_KEY));
            if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
              authenticated = true;
              clearTimeout(authTimeout);
              authenticatedClients.add(ws);
              ws.send(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));
            } else {
              // Also check client API keys
              try {
                const keyHash = crypto.createHash('sha256').update(msg.api_key).digest('hex');
                const keyRecord = db.prepare('SELECT id FROM client_api_keys WHERE api_key_hash = ? AND is_active = 1').get(keyHash);
                if (keyRecord) {
                  authenticated = true;
                  clearTimeout(authTimeout);
                  authenticatedClients.add(ws);
                  ws.send(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));
                  return;
                }
              } catch (e) { /* ignore DB errors */ }

              ws.close(4003, 'Invalid API key');
            }
            return;
          }

          // Ignore non-auth messages from unauthenticated clients
          if (!authenticated) return;

        } catch (err) {
          // Invalid JSON, ignore
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        authenticatedClients.delete(ws);
      });

      ws.on('error', () => {
        clearTimeout(authTimeout);
        authenticatedClients.delete(ws);
      });

      // Send challenge — tell client to authenticate
      ws.send(JSON.stringify({ type: 'auth_required', timestamp: new Date().toISOString() }));
    });

    // Heartbeat
    heartbeatInterval = setInterval(() => {
      for (const client of authenticatedClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        } else {
          authenticatedClients.delete(client);
        }
      }
    }, WEBSOCKET_HEARTBEAT_INTERVAL_MS);

    console.log('[ws] WebSocket server initialized on /ws (message-based auth)');
  } catch (err) {
    console.warn('[ws] WebSocket init failed:', err.message);
  }
}

function cleanupWebSocket() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (wss) {
    wss.close(() => {
      console.log('[ws] WebSocket server closed');
    });
  }
}

function broadcast(event, data) {
  if (!wss || authenticatedClients.size === 0) return;

  const message = JSON.stringify({ type: event, data, timestamp: new Date().toISOString() });

  for (const client of authenticatedClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        authenticatedClients.delete(client);
      }
    }
  }
}

function getConnectionCount() {
  return authenticatedClients.size;
}

module.exports = { initWebSocket, broadcast, getConnectionCount, cleanupWebSocket };
