const { logger } = require('./logger');
const { CircuitBreaker } = require('./resilience');
const { AppError } = require('./AppError');

const CALCOM_API_KEY = process.env.CALCOM_API_KEY;
const BASE_URL = 'https://api.cal.com/v2';
const API_VERSION = '2024-08-13';

// Circuit breaker for Cal.com API — opens after 3 failures in 60s, cools down 30s.
const calcomBreaker = new CircuitBreaker(
  async (url, opts) => {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
    if (!resp.ok) throw new AppError('UPSTREAM_ERROR', `Cal.com API ${resp.status}`, 502);
    return resp;
  },
  {
    failureThreshold: 3,
    failureWindow: 60000,
    cooldownPeriod: 30000,
    serviceName: 'Cal.com',
    fallback: () => ({ ok: false, fallback: true }),
  }
);

function headers() {
  return {
    'Authorization': `Bearer ${CALCOM_API_KEY}`,
    'Content-Type': 'application/json',
    'cal-api-version': API_VERSION
  };
}

/**
 * Fetch bookings for an event type within a date range.
 * @param {string|number} eventTypeId
 * @param {string} [startDate] - ISO date string
 * @param {string} [endDate] - ISO date string
 * @returns {Promise<Array>}
 */
async function getBookings(eventTypeId, startDate, endDate) {
  try {
    const params = new URLSearchParams();
    if (eventTypeId) params.set('eventTypeId', eventTypeId);
    if (startDate) params.set('afterStart', startDate);
    if (endDate) params.set('beforeEnd', endDate);

    const resp = await calcomBreaker.call(`${BASE_URL}/bookings?${params.toString()}`, {
      headers: headers(),
    });

    if (resp.fallback) {
      logger.warn('[calcom] getBookings — Cal.com circuit open');
      return [];
    }

    const data = await resp.json();
    return data.data || data.bookings || [];
  } catch (err) {
    logger.error('[calcom] getBookings error:', err);
    return [];
  }
}

/**
 * Cancel a booking by ID.
 * @param {string|number} bookingId
 * @returns {Promise<{success: boolean}>}
 */
async function cancelBooking(bookingId) {
  try {
    const resp = await calcomBreaker.call(`${BASE_URL}/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: headers(),
    });

    if (resp.fallback) {
      logger.warn('[calcom] cancelBooking — Cal.com circuit open');
      return { success: false, error: 'Cal.com temporarily unavailable' };
    }

    logger.info(`[calcom] Booking ${bookingId} cancelled`);
    return { success: true };
  } catch (err) {
    logger.error('[calcom] cancelBooking error:', err);
    return { success: false };
  }
}

/**
 * Get available time slots for an event type on a given date.
 * @param {string|number} eventTypeId
 * @param {string} date - ISO date string (YYYY-MM-DD)
 * @returns {Promise<Array>}
 */
async function getAvailability(eventTypeId, date) {
  try {
    const params = new URLSearchParams({
      eventTypeId: String(eventTypeId),
      startTime: `${date}T00:00:00.000Z`,
      endTime: `${date}T23:59:59.999Z`
    });

    const resp = await calcomBreaker.call(`${BASE_URL}/slots/available?${params.toString()}`, {
      headers: headers(),
    });

    if (resp.fallback) {
      logger.warn('[calcom] getAvailability — Cal.com circuit open');
      return [];
    }

    const data = await resp.json();
    return data.data?.slots || data.slots || [];
  } catch (err) {
    logger.error('[calcom] getAvailability error:', err);
    return [];
  }
}

/**
 * Create a booking via Cal.com API.
 * @param {object} opts
 * @param {string|number} opts.eventTypeId - Cal.com event type ID
 * @param {string} opts.startTime - ISO datetime for the booking
 * @param {string} opts.name - Attendee name
 * @param {string} opts.email - Attendee email
 * @param {string} [opts.phone] - Attendee phone
 * @param {object} [opts.metadata] - Additional metadata
 * @returns {Promise<{success: boolean, booking?: object, error?: string}>}
 */
async function createBooking(opts) {
  const { eventTypeId, startTime, name, email, phone, metadata } = opts;

  if (!CALCOM_API_KEY) {
    logger.error('[calcom] No CALCOM_API_KEY configured');
    return { success: false, error: 'Cal.com API key not configured' };
  }

  if (!eventTypeId || !startTime || !email) {
    return { success: false, error: 'Missing required fields: eventTypeId, startTime, email' };
  }

  try {
    const body = {
      eventTypeId: Number(eventTypeId),
      start: startTime,
      responses: {
        name: name || 'Guest',
        email: email,
      },
      metadata: metadata || {},
    };

    if (phone) {
      body.responses.phone = phone;
    }

    const resp = await calcomBreaker.call(`${BASE_URL}/bookings`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });

    if (resp.fallback) {
      logger.warn('[calcom] createBooking — Cal.com circuit open');
      return { success: false, error: 'Cal.com temporarily unavailable — please try again shortly' };
    }

    const data = await resp.json();
    const booking = data.data || data;
    logger.info(`[calcom] Booking created: ${booking.uid || booking.id} for ${email} at ${startTime}`);
    return { success: true, booking };
  } catch (err) {
    logger.error('[calcom] createBooking error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { getBookings, cancelBooking, getAvailability, createBooking, _calcomBreaker: calcomBreaker };
