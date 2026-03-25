/**
 * Tests for calcom.js
 * Tests Cal.com API integration for booking management
 */

const { getBookings, cancelBooking, getAvailability, createBooking } = require('../utils/calcom');

jest.mock('node-fetch');

describe('calcom', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.CALCOM_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CALCOM_API_KEY = 'test-api-key-123';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env.CALCOM_API_KEY = originalEnv;
    global.fetch = originalFetch;
  });

  describe('getBookings', () => {
    test('fetches bookings for an event type', async () => {
      const mockResponse = {
        data: [
          {
            id: '1',
            title: 'John Doe',
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 3600000).toISOString()
          }
        ]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await getBookings('123');

      expect(result).toEqual(mockResponse.data);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/bookings'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key-123'
          })
        })
      );
    });

    test('filters bookings by date range', async () => {
      const mockResponse = { data: [] };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const startDate = '2025-03-01';
      const endDate = '2025-03-31';
      await getBookings('123', startDate, endDate);

      const url = global.fetch.mock.calls[0][0];
      expect(url).toContain('afterStart=' + startDate);
      expect(url).toContain('beforeEnd=' + endDate);
    });

    test('returns empty array on API error', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('API Error')
      });

      const result = await getBookings('123');

      expect(result).toEqual([]);
    });

    test('returns empty array on network error', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));

      const result = await getBookings('123');

      expect(result).toEqual([]);
    });

    test('handles legacy response format with bookings property', async () => {
      const mockResponse = {
        bookings: [{ id: '1', title: 'Test' }]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await getBookings('123');

      expect(result).toEqual(mockResponse.bookings);
    });
  });

  describe('cancelBooking', () => {
    test('cancels a booking by ID', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ ok: true })
      });

      const result = await cancelBooking('booking-123');

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/bookings/booking-123/cancel'),
        expect.objectContaining({
          method: 'POST'
        })
      );
    });

    test('returns false on API error', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Error')
      });

      const result = await cancelBooking('booking-123');

      expect(result.success).toBe(false);
    });

    test('returns false on network error', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));

      const result = await cancelBooking('booking-123');

      expect(result.success).toBe(false);
    });

    test('includes auth headers in request', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({})
      });

      await cancelBooking('booking-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key-123'
          })
        })
      );
    });
  });

  describe('getAvailability', () => {
    test('fetches available slots for a date', async () => {
      const mockResponse = {
        data: {
          slots: [
            '2025-03-30T09:00:00Z',
            '2025-03-30T10:00:00Z',
            '2025-03-30T11:00:00Z'
          ]
        }
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await getAvailability('123', '2025-03-30');

      expect(result).toEqual(mockResponse.data.slots);
    });

    test('includes event type and date in query', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { slots: [] } })
      });

      await getAvailability('456', '2025-03-30');

      const url = global.fetch.mock.calls[0][0];
      expect(url).toContain('eventTypeId=456');
      expect(url).toContain('2025-03-30');
    });

    test('returns empty array on API error', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Error')
      });

      const result = await getAvailability('123', '2025-03-30');

      expect(result).toEqual([]);
    });

    test('handles legacy response format with slots property', async () => {
      const mockResponse = {
        slots: ['2025-03-30T09:00:00Z']
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await getAvailability('123', '2025-03-30');

      expect(result).toEqual(mockResponse.slots);
    });
  });

  describe('createBooking', () => {
    test('creates a booking with required fields', async () => {
      const mockResponse = {
        data: {
          id: 'booking-123',
          uid: 'unique-id-123',
          startTime: '2025-03-30T14:00:00Z'
        }
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'john@example.com'
      });

      expect(result.success).toBe(true);
      expect(result.booking).toEqual(mockResponse.data);
    });

    test('includes optional phone field if provided', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { id: '1' } })
      });

      await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'john@example.com',
        phone: '+1-212-555-1234'
      });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.responses.phone).toBe('+1-212-555-1234');
    });

    test('includes metadata if provided', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { id: '1' } })
      });

      const metadata = { lead_id: 'lead-123', source: 'brain' };
      await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'john@example.com',
        metadata
      });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.metadata).toEqual(metadata);
    });

    test('returns error when required fields missing', async () => {
      const result = await createBooking({
        eventTypeId: '123',
        // missing startTime, email
        name: 'John Doe'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    test('returns error when API key not configured', async () => {
      process.env.CALCOM_API_KEY = '';

      const result = await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'john@example.com'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('handles API error response', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: jest.fn().mockResolvedValue('Invalid email')
      });

      const result = await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'invalid-email'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('400');
    });

    test('handles network errors', async () => {
      global.fetch.mockRejectedValue(new Error('Network timeout'));

      const result = await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'john@example.com'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
    });

    test('uses default name when name not provided', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { id: '1' } })
      });

      await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        email: 'john@example.com'
      });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.responses.name).toBe('Guest');
    });

    test('converts eventTypeId to number', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { id: '1' } })
      });

      await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'john@example.com'
      });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(typeof body.eventTypeId).toBe('number');
      expect(body.eventTypeId).toBe(123);
    });

    test('includes correct API headers', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { id: '1' } })
      });

      await createBooking({
        eventTypeId: '123',
        startTime: '2025-03-30T14:00:00Z',
        name: 'John Doe',
        email: 'john@example.com'
      });

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer test-api-key-123');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['cal-api-version']).toBeDefined();
    });
  });
});
