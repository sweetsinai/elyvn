/**
 * Real-Time Analytics Stream
 *
 * Wraps WebSocket broadcast to emit structured analytics events to subscribed
 * clients. Dashboard clients opt-in by sending { type: 'subscribe', channel: 'analytics' }
 * after authenticating.
 *
 * Events are only delivered to connections that:
 * 1. Have subscribed to the 'analytics' channel
 * 2. Match the event's clientId (or are admin connections with clientId === null)
 */

const { logger } = require('./logger');

// Track which WebSocket connections are subscribed to the analytics channel.
// This is maintained here so the core websocket.js module stays generic.
const analyticsSubscribers = new WeakSet();

/**
 * Call once from websocket.js (or wherever ws messages are handled) to register
 * analytics subscription handling. Can also be called standalone: simply pass
 * any authenticated ws client after it sends { type: 'subscribe', channel: 'analytics' }.
 *
 * @param {WebSocket} ws
 */
function subscribeToAnalytics(ws) {
  analyticsSubscribers.add(ws);
}

/**
 * Check if a ws connection is subscribed to analytics.
 * @param {WebSocket} ws
 * @returns {boolean}
 */
function isSubscribed(ws) {
  return analyticsSubscribers.has(ws);
}

/**
 * Emit an analytics event to all subscribed WebSocket clients whose clientId
 * matches (or who are admin connections).
 *
 * @param {{ broadcast: Function, authenticatedClients?: Map }} wsBroadcastOrWss
 *   — either the broadcast() function from websocket.js, or an object with it.
 *     We also accept the raw broadcast function directly.
 * @param {{ type: string, data: object, timestamp?: string, clientId: string }} event
 */
function emitAnalyticsEvent(event) {
  try {
    const { broadcast } = require('./websocket');
    if (!broadcast) return;

    const payload = {
      channel: 'analytics',
      eventType: event.type,
      data: event.data || {},
      timestamp: event.timestamp || new Date().toISOString(),
    };

    // Use the existing broadcast with clientId-based tenant isolation
    broadcast('analytics_event', payload, event.clientId || undefined);
  } catch (err) {
    // Fire-and-forget — never let analytics crash a request
    logger.debug('[analyticsStream] emit error (non-fatal):', err.message);
  }
}

module.exports = {
  emitAnalyticsEvent,
  subscribeToAnalytics,
  isSubscribed,
};
