'use strict';

const { AppError } = require('../utils/AppError');

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return next(new AppError('VALIDATION_ERROR', message, 400));
    }
    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const message = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return next(new AppError('VALIDATION_ERROR', message, 400));
    }
    req.query = result.data;
    next();
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const message = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return next(new AppError('VALIDATION_ERROR', message, 400));
    }
    req.params = result.data;
    next();
  };
}

module.exports = { validateBody, validateQuery, validateParams };
