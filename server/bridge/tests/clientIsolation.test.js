'use strict';

const { enforceClientIsolation, requirePermission, resolveClientId } = require('../utils/clientIsolation');

describe('Client Isolation Middleware', () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    mockNext = jest.fn();
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      sendStatus: jest.fn(),
    };
    mockReq = {
      method: 'GET',
      ip: '192.168.1.1',
      params: {},
      query: {},
      body: {},
    };
  });

  describe('enforceClientIsolation', () => {
    test('admin key bypasses isolation check', () => {
      mockReq.isAdmin = true;
      mockReq.clientId = 'client-123';
      mockReq.params.clientId = 'client-456'; // Different clientId

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('unauthenticated request passes through', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = undefined;

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('client with matching clientId in params passes', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.params.clientId = 'client-123';

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('client with mismatched clientId in params gets 403', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.params.clientId = 'client-999';

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Access denied — you can only access your own client data',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('checks clientId in query parameters', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.query.clientId = 'client-999';

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('checks client_id in query parameters (snake_case)', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.query.client_id = 'client-999';

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('injects clientId into body for POST requests', () => {
      mockReq.method = 'POST';
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.body = { name: 'Test Lead' };

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockReq.body.client_id).toBe('client-123');
      expect(mockNext).toHaveBeenCalled();
    });

    test('injects clientId into body for PUT requests', () => {
      mockReq.method = 'PUT';
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-456';
      mockReq.body = { status: 'updated' };

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockReq.body.client_id).toBe('client-456');
      expect(mockNext).toHaveBeenCalled();
    });

    test('injects clientId into body for PATCH requests', () => {
      mockReq.method = 'PATCH';
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-789';
      mockReq.body = { field: 'value' };

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockReq.body.client_id).toBe('client-789');
      expect(mockNext).toHaveBeenCalled();
    });

    test('does not inject clientId for GET requests', () => {
      mockReq.method = 'GET';
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.body = {};

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockReq.body.client_id).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
    });

    test('does not override existing client_id in body', () => {
      mockReq.method = 'POST';
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.body = { client_id: 'client-456' }; // Already set

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockReq.body.client_id).toBe('client-456'); // Preserved
      expect(mockNext).toHaveBeenCalled();
    });

    test('handles missing body in POST request', () => {
      mockReq.method = 'POST';
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.body = null;

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    test('logs security violation on isolation bypass attempt', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.params.clientId = 'client-999';

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SECURITY] Client isolation bypass attempt')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Client client-123 tried to access client-999')
      );

      consoleSpy.mockRestore();
    });

    test('precedence: params > query in isolation check', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = 'client-123';
      mockReq.params.clientId = 'client-999'; // Params take precedence
      mockReq.query.clientId = 'client-123'; // Would match if checked

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('client-999')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('requirePermission', () => {
    test('admin key bypasses permission check', () => {
      mockReq.isAdmin = true;
      mockReq.keyPermissions = ['read'];
      const middleware = requirePermission('write');

      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('allows request with matching permission', () => {
      mockReq.isAdmin = false;
      mockReq.keyPermissions = ['read', 'write'];
      const middleware = requirePermission('write');

      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('denies request without matching permission', () => {
      mockReq.isAdmin = false;
      mockReq.keyPermissions = ['read'];
      const middleware = requirePermission('write');

      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Insufficient permissions — requires 'write'",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('allows if admin permission is present', () => {
      mockReq.isAdmin = false;
      mockReq.keyPermissions = ['read', 'admin'];
      const middleware = requirePermission('write');

      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('defaults to read-only permission if not specified', () => {
      mockReq.isAdmin = false;
      mockReq.keyPermissions = undefined;
      const middleware = requirePermission('read');

      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    test('denies when keyPermissions not set and requiring write', () => {
      mockReq.isAdmin = false;
      mockReq.keyPermissions = undefined;
      const middleware = requirePermission('write');

      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('resolveClientId', () => {
    test('prioritizes URL param', () => {
      mockReq.params.clientId = 'param-id';
      mockReq.query.clientId = 'query-id';
      mockReq.body.client_id = 'body-id';
      mockReq.clientId = 'key-id';

      const result = resolveClientId(mockReq);
      expect(result).toBe('param-id');
    });

    test('falls back to query param', () => {
      mockReq.params.clientId = undefined;
      mockReq.query.clientId = 'query-id';
      mockReq.body.client_id = 'body-id';
      mockReq.clientId = 'key-id';

      const result = resolveClientId(mockReq);
      expect(result).toBe('query-id');
    });

    test('falls back to body client_id', () => {
      mockReq.params.clientId = undefined;
      mockReq.query.clientId = undefined;
      mockReq.body.client_id = 'body-id';
      mockReq.clientId = 'key-id';

      const result = resolveClientId(mockReq);
      expect(result).toBe('body-id');
    });

    test('falls back to API key clientId', () => {
      mockReq.params.clientId = undefined;
      mockReq.query.clientId = undefined;
      mockReq.body.client_id = undefined;
      mockReq.clientId = 'key-id';

      const result = resolveClientId(mockReq);
      expect(result).toBe('key-id');
    });

    test('returns null if no clientId found', () => {
      mockReq.params.clientId = undefined;
      mockReq.query.clientId = undefined;
      mockReq.body.client_id = undefined;
      mockReq.clientId = undefined;

      const result = resolveClientId(mockReq);
      expect(result).toBeNull();
    });

    test('handles missing body object', () => {
      mockReq.params.clientId = undefined;
      mockReq.query.clientId = undefined;
      mockReq.body = undefined;
      mockReq.clientId = 'key-id';

      const result = resolveClientId(mockReq);
      expect(result).toBe('key-id');
    });
  });

  describe('Security scenarios', () => {
    test('prevents cross-client data access via param injection', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = 'abc-123-def';
      mockReq.params.clientId = '../../../xyz-999-abc'; // Attempted injection

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('prevents cross-client data access via query injection', () => {
      mockReq.isAdmin = false;
      mockReq.clientId = 'abc-123-def';
      mockReq.query.client_id = 'xyz-999-abc'; // Attempted injection

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('admin bypass works with suspicious params', () => {
      mockReq.isAdmin = true;
      mockReq.clientId = 'admin-key';
      mockReq.params.clientId = 'any-client-id';

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('POST with matching clientId injects without error', () => {
      mockReq.method = 'POST';
      mockReq.isAdmin = false;
      mockReq.clientId = 'safe-client';
      mockReq.params.clientId = 'safe-client';
      mockReq.body = { data: 'test' };

      enforceClientIsolation(mockReq, mockRes, mockNext);

      expect(mockReq.body.client_id).toBe('safe-client');
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
