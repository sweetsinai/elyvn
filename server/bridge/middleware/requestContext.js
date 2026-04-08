/**
 * Request Context Middleware
 * Assigns a unique request ID to every incoming request and binds it to
 * the async context so all logger calls within the request lifecycle
 * automatically include the requestId without explicit passing.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Middleware that assigns a requestId (from x-request-id header or a new UUID)
 * and stores it in AsyncLocalStorage alongside the clientId, making it
 * automatically available to all async operations within the request.
 *
 * Must be applied AFTER helmet but BEFORE routes.
 */
const requestContext = (req, res, next) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', requestId);
  asyncLocalStorage.run({ requestId, clientId: req.clientId }, next);
};

module.exports = { asyncLocalStorage, requestContext };
