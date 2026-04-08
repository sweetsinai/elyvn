/**
 * Conversation Intelligence — Peak Hours Analysis
 */

const { AppError } = require('../AppError');

/**
 * Get peak activity hours for a client
 * @param {object} db
 * @param {string} clientId
 * @returns {Array<{hour: number, day: string, calls: number, messages: number, bookings: number}>}
 */
async function getPeakHours(db, clientId) {
  if (!db || !clientId) {
    throw new AppError('VALIDATION_ERROR', 'db and clientId are required', 400);
  }

  const hourStats = await db.query(`
    SELECT
      CAST(strftime('%H', calls.created_at) AS INTEGER) as hour,
      strftime('%w', calls.created_at) as dow_num,
      COUNT(*) as call_count,
      SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) as booking_count
    FROM calls
    WHERE client_id = ?
    GROUP BY hour, dow_num
    ORDER BY call_count DESC
    LIMIT 24
  `, [clientId]);

  const messageStats = await db.query(`
    SELECT
      CAST(strftime('%H', created_at) AS INTEGER) as hour,
      strftime('%w', created_at) as dow_num,
      COUNT(*) as msg_count
    FROM messages
    WHERE client_id = ?
    GROUP BY hour, dow_num
    LIMIT 24
  `, [clientId]);

  const msgMap = new Map();
  for (const stat of messageStats) {
    msgMap.set(`${stat.hour}:${stat.dow_num}`, stat.msg_count);
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const combined = hourStats.map(stat => ({
    hour: stat.hour,
    day: dayNames[parseInt(stat.dow_num)],
    calls: stat.call_count || 0,
    messages: msgMap.get(`${stat.hour}:${stat.dow_num}`) || 0,
    bookings: stat.booking_count || 0,
  }));

  return combined.slice(0, 14);
}

module.exports = { getPeakHours };
