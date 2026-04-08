'use strict';

const { AppError } = require('../../../utils/AppError');

describe('AppError', () => {
  describe('constructor', () => {
    it('should set code, message, and default statusCode', () => {
      const err = new AppError('NOT_FOUND', 'Resource not found');
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('Resource not found');
      expect(err.statusCode).toBe(500);
    });

    it('should set a custom statusCode', () => {
      const err = new AppError('NOT_FOUND', 'Resource not found', 404);
      expect(err.statusCode).toBe(404);
    });

    it('should set name to AppError', () => {
      const err = new AppError('ANY', 'msg');
      expect(err.name).toBe('AppError');
    });

    it('should be an instance of Error', () => {
      const err = new AppError('ANY', 'msg');
      expect(err).toBeInstanceOf(Error);
    });

    it('should be an instance of AppError', () => {
      const err = new AppError('ANY', 'msg');
      expect(err).toBeInstanceOf(AppError);
    });

    it('should preserve the message via Error.prototype', () => {
      const err = new AppError('VALIDATION_ERROR', 'Invalid input', 422);
      expect(err.message).toBe('Invalid input');
    });

    it('should have a stack trace', () => {
      const err = new AppError('ANY', 'msg');
      expect(err.stack).toBeDefined();
      expect(typeof err.stack).toBe('string');
    });
  });

  describe('statusCode variants', () => {
    it('should support 400 Bad Request', () => {
      const err = new AppError('BAD_REQUEST', 'Bad request', 400);
      expect(err.statusCode).toBe(400);
    });

    it('should support 401 Unauthorized', () => {
      const err = new AppError('UNAUTHORIZED', 'Unauthorized', 401);
      expect(err.statusCode).toBe(401);
    });

    it('should support 403 Forbidden', () => {
      const err = new AppError('FORBIDDEN', 'Forbidden', 403);
      expect(err.statusCode).toBe(403);
    });

    it('should support 404 Not Found', () => {
      const err = new AppError('NOT_FOUND', 'Not found', 404);
      expect(err.statusCode).toBe(404);
    });

    it('should support 500 Internal Server Error (default)', () => {
      const err = new AppError('SERVER_ERROR', 'Something went wrong');
      expect(err.statusCode).toBe(500);
    });
  });

  describe('isOperational flag', () => {
    it('should be distinguishable from a generic Error by name', () => {
      const appErr = new AppError('CODE', 'msg', 400);
      const genericErr = new Error('msg');
      expect(appErr.name).toBe('AppError');
      expect(genericErr.name).toBe('Error');
    });

    it('should have code property that generic Error lacks', () => {
      const appErr = new AppError('SOME_CODE', 'msg');
      expect(appErr.code).toBeDefined();
      expect(new Error('msg').code).toBeUndefined();
    });
  });

  describe('throwing and catching', () => {
    it('should be catchable as an Error', () => {
      expect(() => {
        throw new AppError('TEST', 'thrown error', 500);
      }).toThrow('thrown error');
    });

    it('should retain all properties after being thrown and caught', () => {
      let caught;
      try {
        throw new AppError('CONFLICT', 'Already exists', 409);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught.code).toBe('CONFLICT');
      expect(caught.message).toBe('Already exists');
      expect(caught.statusCode).toBe(409);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string message', () => {
      const err = new AppError('EMPTY', '');
      expect(err.message).toBe('');
    });

    it('should handle statusCode of 0', () => {
      const err = new AppError('CODE', 'msg', 0);
      expect(err.statusCode).toBe(0);
    });

    it('should handle long messages', () => {
      const longMsg = 'x'.repeat(5000);
      const err = new AppError('CODE', longMsg);
      expect(err.message).toBe(longMsg);
    });
  });
});
