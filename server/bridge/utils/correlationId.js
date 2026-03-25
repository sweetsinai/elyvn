'use strict';
const crypto = require('crypto');

function correlationMiddleware(req, res, next) {
  req.correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}

module.exports = { correlationMiddleware };
