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
      console.error(`[calcom] getBookings failed (${resp.status}):`, errText);
      return [];
    }

    const data = await resp.json();
    return data.data || data.bookings || [];
  } catch (err) {
    console.error('[calcom] getBookings error:', err);
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
      console.error(`[calcom] cancelBooking failed (${resp.status}):`, errText);
      return { success: false };
    }

    console.log(`[calcom] Booking ${bookingId} cancelled`);
    return { success: true };
  } catch (err) {
    console.error('[calcom] cancelBooking error:', err);
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
      console.error(`[calcom] getAvailability failed (${resp.status}):`, errText);
      return [];
    }

    const data = await resp.json();
    return data.data?.slots || data.slots || [];
  } catch (err) {
    console.error('[calcom] getAvailability error:', err);
    return [];
  }
}

module.exports = { getBookings, cancelBooking, getAvailability };
