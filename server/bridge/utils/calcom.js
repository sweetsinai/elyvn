const { logger } = require('./logger');

const CALCOM_API_KEY = process.env.CALCOM_API_KEY;
const BASE_URL = 'https://api.cal.com/v2';
const API_VERSION = '2024-08-13';

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

    const resp = await fetch(`${BASE_URL}/bookings?${params.toString()}`, {
      headers: headers()
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.error(`[calcom] getBookings failed (${resp.status}):`, errText);
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
    const resp = await fetch(`${BASE_URL}/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: headers()
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.error(`[calcom] cancelBooking failed (${resp.status}):`, errText);
      return { success: false };
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

    const resp = await fetch(`${BASE_URL}/slots/available?${params.toString()}`, {
      headers: headers()
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.error(`[calcom] getAvailability failed (${resp.status}):`, errText);
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

    const resp = await fetch(`${BASE_URL}/bookings`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.error(`[calcom] createBooking failed (${resp.status}):`, errText.substring(0, 300));
      return { success: false, error: `Cal.com API error: ${resp.status}` };
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

module.exports = { getBookings, cancelBooking, getAvailability, createBooking };
