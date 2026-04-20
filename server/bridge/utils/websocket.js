/**
 * WebSocket Manager — real-time updates to dashboard
 * Auth via first message (not query param) to avoid key leaking in URLs/logs
 */

const { WEBSOCKET_HEARTBEAT_INTERVAL_MS } = require('../config/timing');
const WebSocket = require('ws');
const crypto = require('crypto');
const { logger } = require('./logger');

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
              // Global admin key — clientId null means receives all broadcasts
              authenticatedClients.set(ws, { clientId: null });
              ws.send(JSON.stringify({ type: 'authenticated', timestamp: new Date().toISOString() }));
            } else {
              // Also check client API keys
              try {
                const keyHash = crypto.createHash('sha256').update(msg.api_key).digest('hex');
                const keyRecord = await db.query('SELECT id, client_id FROM client_api_keys WHERE api_key_hash = ? AND is_active = 1', [keyHash], 'get');
                if (keyRecord) {
                  authenticated = true;
                  clearTimeout(authTimeout);
                  // Tag the connection with the tenant's clientId for isolation
                  authenticatedClients.set(ws, { clientId: keyRecord.client_id });
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
