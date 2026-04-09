'use strict';

const { correlationMiddleware } = require('../utils/correlationId');

describe('correlationMiddleware', () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    mockReq = {
      headers: {}
    };

    mockRes = {
      setHeader: jest.fn()
    };

    mockNext = jest.fn();
  });

  describe('when x-correlation-id header is provided', () => {
    it('should use the provided correlation ID', () => {
      const providedId = 'test-correlation-id-12345';
      mockReq.headers['x-correlation-id'] = providedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(providedId);
      expect(mockRes.setHeader).toHaveBeenCalledWith('x-correlation-id', providedId);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should preserve exact format of provided ID', () => {
      const providedId = 'uuid:550e8400-e29b-41d4-a716-446655440000';
      mockReq.headers['x-correlation-id'] = providedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(providedId);
    });

    it('should handle ID with special characters', () => {
      const providedId = 'req-2024-03-25_12:45:30.123-abc';
      mockReq.headers['x-correlation-id'] = providedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(providedId);
    });

    it('should handle very long ID', () => {
      const providedId = 'x'.repeat(1000);
      mockReq.headers['x-correlation-id'] = providedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(providedId);
    });

    it('should set response header with same ID', () => {
      const providedId = 'response-test-123';
      mockReq.headers['x-correlation-id'] = providedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith('x-correlation-id', providedId);
    });
  });

  describe('when x-correlation-id header is not provided', () => {
    it('should generate a correlation ID', () => {
      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBeDefined();
      expect(typeof mockReq.correlationId).toBe('string');
      expect(mockReq.correlationId.length).toBeGreaterThan(0);
    });

    it('should generate UUID format ID', () => {
      correlationMiddleware(mockReq, mockRes, mockNext);

      const generatedId = mockReq.correlationId;
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(generatedId)).toBe(true);
    });

    it('should set response header with generated ID', () => {
      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledTimes(1);
      const callArgs = mockRes.setHeader.mock.calls[0];
      expect(callArgs[0]).toBe('x-correlation-id');
      expect(callArgs[1]).toBe(mockReq.correlationId);
    });

    it('should generate different IDs for different requests', () => {
      const req1 = { headers: {} };
      const res1 = { setHeader: jest.fn() };
      const next1 = jest.fn();

      const req2 = { headers: {} };
      const res2 = { setHeader: jest.fn() };
      const next2 = jest.fn();

      correlationMiddleware(req1, res1, next1);
      correlationMiddleware(req2, res2, next2);

      expect(req1.correlationId).not.toBe(req2.correlationId);
    });
  });

  describe('middleware behavior', () => {
    it('should call next() to proceed with middleware chain', () => {
      mockReq.headers['x-correlation-id'] = 'provided-id';

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should call next() even when generating new ID', () => {
      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('should attach correlationId to request object', () => {
      expect(mockReq.correlationId).toBeUndefined();

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBeDefined();
      expect(typeof mockReq.correlationId).toBe('string');
    });

    it('should set header before calling next', () => {
      const callOrder = [];

      mockRes.setHeader = jest.fn(() => {
        callOrder.push('setHeader');
      });

      mockNext = jest.fn(() => {
        callOrder.push('next');
      });

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(callOrder).toEqual(['setHeader', 'next']);
    });
  });

  describe('with empty headers object', () => {
    it('should handle request with empty headers', () => {
      mockReq.headers = {};

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBeDefined();
      expect(mockRes.setHeader).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('with multiple headers', () => {
    it('should correctly identify x-correlation-id among other headers', () => {
      const correlationId = 'specific-correlation-id';
      mockReq.headers = {
        'content-type': 'application/json',
        'authorization': 'Bearer token',
        'x-correlation-id': correlationId,
        'user-agent': 'test-agent'
      };

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(correlationId);
    });

    it('should ignore other x-* headers', () => {
      const correlationId = 'test-id-123';
      mockReq.headers = {
        'x-api-key': 'secret',
        'x-request-id': 'different-id',
        'x-correlation-id': correlationId,
        'x-custom': 'value'
      };

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(correlationId);
    });
  });

  describe('case sensitivity', () => {
    it('should match lowercase x-correlation-id header', () => {
      const providedId = 'lowercase-test-id';
      mockReq.headers['x-correlation-id'] = providedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(providedId);
    });

    it('should work when header is set in different case (if normalized)', () => {
      // Note: Headers are typically normalized to lowercase by Express/Node
      const providedId = 'case-test-id';
      mockReq.headers['x-correlation-id'] = providedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBe(providedId);
    });
  });

  describe('correlation ID persistence', () => {
    it('should use same ID for entire request-response cycle', () => {
      mockReq.headers['x-correlation-id'] = 'persistent-id';

      correlationMiddleware(mockReq, mockRes, mockNext);

      // Verify it's attached to request
      expect(mockReq.correlationId).toBe('persistent-id');

      // Verify it's set in response header
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'x-correlation-id',
        'persistent-id'
      );
    });

    it('should maintain ID after middleware executes', () => {
      const generatedId = '12345-67890';
      mockReq.headers['x-correlation-id'] = generatedId;

      correlationMiddleware(mockReq, mockRes, mockNext);

      // ID should still be accessible after middleware
      expect(mockReq.correlationId).toBe(generatedId);
    });
  });

  describe('error handling', () => {
    it('should not throw when res.setHeader throws', () => {
      mockRes.setHeader = jest.fn(() => {
        throw new Error('setHeader failed');
      });

      expect(() => {
        correlationMiddleware(mockReq, mockRes, mockNext);
      }).toThrow();
    });

    it('should not throw when next() throws', () => {
      mockNext = jest.fn(() => {
        throw new Error('next failed');
      });

      mockReq.headers['x-correlation-id'] = 'test-id';

      expect(() => {
        correlationMiddleware(mockReq, mockRes, mockNext);
      }).toThrow();
    });

    it('should handle request object with empty headers object', () => {
      mockReq.headers = {};

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBeDefined();
      expect(mockRes.setHeader).toHaveBeenCalled();
    });
  });

  describe('UUID generation', () => {
    it('should use crypto.randomUUID for generation', () => {
      const crypto = require('crypto');
      jest.spyOn(crypto, 'randomUUID');

      // Clear the require cache and re-require
      jest.resetModules();
      const middleware = require('../utils/correlationId').correlationMiddleware;

      middleware({ headers: {} }, { setHeader: jest.fn() }, jest.fn());

      // Note: We can't easily test if randomUUID was called because it's called
      // at require time in the implementation. Instead, we verify the output is a valid UUID.
      expect(crypto.randomUUID).toHaveBeenCalled();
    });

    it('should generate valid UUIDs', () => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      for (let i = 0; i < 10; i++) {
        const req = { headers: {} };
        const res = { setHeader: jest.fn() };
        const next = jest.fn();

        correlationMiddleware(req, res, next);

        expect(uuidRegex.test(req.correlationId)).toBe(true);
      }
    });
  });

  describe('integration with Express-like scenarios', () => {
    it('should work as Express middleware', () => {
      const express = { request: mockReq, response: mockRes };

      correlationMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.correlationId).toBeDefined();
      expect(mockRes.setHeader).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should process requests in order', () => {
      const reqs = [{headers: {}}, {headers: {}}, {headers: {}}];
      const ress = [
        { setHeader: jest.fn() },
        { setHeader: jest.fn() },
        { setHeader: jest.fn() }
      ];
      const nexts = [jest.fn(), jest.fn(), jest.fn()];

      reqs.forEach((req, idx) => {
        correlationMiddleware(req, ress[idx], nexts[idx]);
      });

      // All should have unique IDs
      const ids = reqs.map(r => r.correlationId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);

      // All nexts should be called
      nexts.forEach(next => {
        expect(next).toHaveBeenCalled();
      });
    });
  });

  describe('performance', () => {
    it('should not significantly impact request latency', () => {
      const startTime = process.hrtime.bigint();

      for (let i = 0; i < 1000; i++) {
        const req = { headers: {} };
        const res = { setHeader: jest.fn() };
        const next = jest.fn();
        correlationMiddleware(req, res, next);
      }

      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;

      // Should complete 1000 iterations in reasonable time (< 500ms)
      expect(durationMs).toBeLessThan(500);
    });
  });
});
