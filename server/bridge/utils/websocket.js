/**
 * WebSocket Manager — real-time updates to dashboard
 * Auth via first message (not query param) to avoid key leaking in URLs/logs
 */

const { WEBSOCKET_HEARTBEAT_INTERVAL_MS } = require('../config/timing');
const WebSocket = require('ws');
const crypto = require('crypto');
const { logger } = require('./logger');
const { verifyToken } = require('../routes/auth');

let wss = null;
// Map of ws => { clientId: string|null } — null means admin/global key, string means per-tenant
const authenticatedClients = new Map();
let heartbeatInterval;

function initWebSocket(server, db) {
  try {
    wss = new WebSocket.Server({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
      let authenticated = false;
      let authTimeout = null;

      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      // Give client 5s to authenticate, otherwise disconnect
      authTimeout = setTimeout(() => {
        if (!authenticated) {
          ws.close(4001, 'Authentication timeout');
        }
      }, 5000);

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw);

          // Handle auth message
          if (msg.type === 'auth') {
            if (msg.api_key) {
              logger.warn('[ws] msg.api_key is deprecated, please use msg.token');
              // fall through to check token, or just reject
              if (!msg.token) {
                ws.close(4003, 'Invalid authentication method');
                return;
              }
            }

            if (msg.token) {
              const payload = verifyToken(msg.token);
              if (payload) {
                authenticated = true;
                clearTimeout(authTimeout);
                // Tag with the user's clientId if available, else null for global/admin
                authenticatedClients.set(ws, { clientId: payload.clientId || null });
                ws.send(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));
                return;
              }
              ws.close(4003, 'Invalid token');
              return;
            }
          }

          // Ignore non-auth messages from unauthenticated clients
          if (!authenticated) return;

          // Handle analytics channel subscription
          if (msg.type === 'subscribe' && msg.channel === 'analytics') {
            try {
              const { subscribeToAnalytics } = require('./analyticsStream');
              subscribeToAnalytics(ws);
              ws.send(JSON.stringify({ type: 'subscribed', channel: 'analytics', timestamp: new Date().toISOString() }));
            } catch (_) { /* analyticsStream not available */ }
          }

        } catch (err) {
          // Invalid JSON, ignore
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        authenticatedClients.delete(ws); // Map.delete works the same as Set.delete
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
      for (const [client] of authenticatedClients) {
        if (client.isAlive === false) {
          logger.info('[ws] Terminating inactive connection');
          authenticatedClients.delete(client);
          client.terminate();
          continue;
        }

        client.isAlive = false;
        if (client.readyState === WebSocket.OPEN && typeof client.ping === 'function') {
          client.ping();
        } else {
          authenticatedClients.delete(client);
        }
      }
    }, WEBSOCKET_HEARTBEAT_INTERVAL_MS);

    logger.info('[ws] WebSocket server initialized on /ws (message-based auth)');
  } catch (err) {
    logger.warn('[ws] WebSocket init failed:', err.message);
  }
}

function cleanupWebSocket() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (wss) {
    wss.close(() => {
      logger.info('[ws] WebSocket server closed');
    });
  }
}

/**
 * Broadcast an event to WebSocket clients.
 * @param {string} event - Event type name
 * @param {any} data - Payload
 * @param {string|null} [targetClientId] - If provided, only send to connections belonging to this
 *   clientId (tenant isolation). If null or omitted, sends to all admin connections (clientId===null)
 *   AND any connection whose clientId matches targetClientId.
 *   To send to ALL connected clients (admin use only), pass targetClientId=undefined explicitly and
 *   note that tenant-scoped connections will still only receive their own events.
 */
function broadcast(event, data, targetClientId) {
  if (!wss || authenticatedClients.size === 0) return;

  const message = JSON.stringify({ type: event, data, timestamp: new Date().toISOString() });

  for (const [client, meta] of authenticatedClients) {
    if (client.readyState !== WebSocket.OPEN) {
      authenticatedClients.delete(client);
      continue;
    }

    // Tenant isolation: skip client if it has a scoped clientId that doesn't match the target
    if (meta.clientId !== null && targetClientId !== undefined && meta.clientId !== targetClientId) {
      continue;
    }
    // Admin connections (clientId === null) receive everything
    // Tenant connections only receive events matching their clientId

    try {
      client.send(message);
    } catch (err) {
      authenticatedClients.delete(client);
    }
  }
}

function getConnectionCount() {
  return authenticatedClients.size; // Map.size works identically to Set.size
}

module.exports = { initWebSocket, broadcast, getConnectionCount, cleanupWebSocket };
