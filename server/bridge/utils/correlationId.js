'use strict';
const crypto = require('crypto');
const { withCorrelationId } = require('./logger');
const { getActiveTraceId } = require('./tracing');

function correlationMiddleware(req, res, next) {
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  // Attach OTel traceId if a trace is active
  const traceId = getActiveTraceId();
  if (traceId) {
    req.traceId = traceId;
    res.setHeader('x-trace-id', traceId);
  }

  // Bind the correlation ID to the async context so all downstream
  // logger calls automatically include it. Include traceId in context.
  withCorrelationId(traceId ? `${correlationId} trace=${traceId}` : correlationId, () => {
    next();
  });
}

module.exports = { correlationMiddleware };
