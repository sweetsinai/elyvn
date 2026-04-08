'use strict';

const { success, paginated, created } = require('../../../utils/response');

function makeMockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('response helpers', () => {
  describe('success()', () => {
    it('should respond with status 200 by default', () => {
      const res = makeMockRes();
      success(res, { id: 1 });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should set success: true in the response body', () => {
      const res = makeMockRes();
      success(res, { id: 1 });
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
    });

    it('should include the provided data in the response body', () => {
      const res = makeMockRes();
      success(res, { name: 'Alice' });
      const body = res.json.mock.calls[0][0];
      expect(body.data).toEqual({ name: 'Alice' });
    });

    it('should include a timestamp ISO string', () => {
      const res = makeMockRes();
      success(res, null);
      const body = res.json.mock.calls[0][0];
      expect(typeof body.timestamp).toBe('string');
      expect(() => new Date(body.timestamp)).not.toThrow();
    });

    it('should use a custom statusCode when provided', () => {
      const res = makeMockRes();
      success(res, {}, 202);
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('should accept array data', () => {
      const res = makeMockRes();
      success(res, [1, 2, 3]);
      const body = res.json.mock.calls[0][0];
      expect(body.data).toEqual([1, 2, 3]);
    });

    it('should accept null data', () => {
      const res = makeMockRes();
      success(res, null);
      const body = res.json.mock.calls[0][0];
      expect(body.data).toBeNull();
    });

    it('should return the res object (chaining)', () => {
      const res = makeMockRes();
      const returnVal = success(res, {});
      expect(returnVal).toBe(res);
    });
  });

  describe('created()', () => {
    it('should respond with status 201', () => {
      const res = makeMockRes();
      created(res, { id: 99 });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should set success: true', () => {
      const res = makeMockRes();
      created(res, { id: 99 });
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
    });

    it('should include the created resource as data', () => {
      const res = makeMockRes();
      created(res, { id: 99, name: 'Widget' });
      const body = res.json.mock.calls[0][0];
      expect(body.data).toEqual({ id: 99, name: 'Widget' });
    });

    it('should include a timestamp', () => {
      const res = makeMockRes();
      created(res, {});
      const body = res.json.mock.calls[0][0];
      expect(typeof body.timestamp).toBe('string');
    });

    it('should not include a pagination field', () => {
      const res = makeMockRes();
      created(res, {});
      const body = res.json.mock.calls[0][0];
      expect(body.pagination).toBeUndefined();
    });
  });

  describe('paginated()', () => {
    it('should respond with status 200', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 0, limit: 10, offset: 0 });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should set success: true', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 0, limit: 10, offset: 0 });
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
    });

    it('should include data array in the body', () => {
      const res = makeMockRes();
      const data = [{ id: 1 }, { id: 2 }];
      paginated(res, { data, total: 2, limit: 10, offset: 0 });
      const body = res.json.mock.calls[0][0];
      expect(body.data).toEqual(data);
    });

    it('should include a pagination object with correct shape', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 100, limit: 20, offset: 40 });
      const body = res.json.mock.calls[0][0];
      expect(body.pagination).toEqual({
        total: 100,
        limit: 20,
        offset: 40,
        hasMore: true,
      });
    });

    it('should set hasMore to true when more pages exist', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 100, limit: 10, offset: 0 });
      const body = res.json.mock.calls[0][0];
      expect(body.pagination.hasMore).toBe(true);
    });

    it('should set hasMore to false on the last page', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 30, limit: 10, offset: 20 });
      const body = res.json.mock.calls[0][0];
      expect(body.pagination.hasMore).toBe(false);
    });

    it('should set hasMore to false for empty results', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 0, limit: 10, offset: 0 });
      const body = res.json.mock.calls[0][0];
      expect(body.pagination.hasMore).toBe(false);
    });

    it('should include a timestamp', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 0, limit: 10, offset: 0 });
      const body = res.json.mock.calls[0][0];
      expect(typeof body.timestamp).toBe('string');
    });

    it('should correctly compute hasMore for mid-page boundary', () => {
      const res = makeMockRes();
      // offset=10, limit=10, total=20 → offset+limit=20 == total → NOT hasMore
      paginated(res, { data: [], total: 20, limit: 10, offset: 10 });
      const body = res.json.mock.calls[0][0];
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  describe('response shape contract', () => {
    it('success response has exactly: success, data, timestamp', () => {
      const res = makeMockRes();
      success(res, { foo: 'bar' });
      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body).sort()).toEqual(['data', 'success', 'timestamp'].sort());
    });

    it('created response has exactly: success, data, timestamp', () => {
      const res = makeMockRes();
      created(res, { foo: 'bar' });
      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body).sort()).toEqual(['data', 'success', 'timestamp'].sort());
    });

    it('paginated response has exactly: success, data, pagination, timestamp', () => {
      const res = makeMockRes();
      paginated(res, { data: [], total: 0, limit: 10, offset: 0 });
      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body).sort()).toEqual(['data', 'pagination', 'success', 'timestamp'].sort());
    });
  });
});
