/**
 * Business Hours Awareness
 * Checks if operations should occur within client business hours
 * and schedules them for next business hour if outside
 */

/**
 * Parse business hours string format
 * @param {string} hoursStr - Format: "Mon-Fri:8-20,Sat:9-17"
 * @returns {object} Parsed hours by day
 */
function parseBusinessHours(hoursStr) {
  const defaultHours = {
    Monday: { open: 8, close: 20 },
    Tuesday: { open: 8, close: 20 },
    Wednesday: { open: 8, close: 20 },
    Thursday: { open: 8, close: 20 },
    Friday: { open: 8, close: 20 },
    Saturday: { open: 9, close: 17 },
    Sunday: null, // closed
  };

  if (!hoursStr) return defaultHours;

  const hours = { ...defaultHours };
  const parts = hoursStr.split(',');

  for (const part of parts) {
    const [days, times] = part.split(':');
    if (!times) continue;

    const [open, close] = times.split('-').map(Number);
    const dayList = days
      .split('-')
      .map(d => d.trim())
      .map(d => {
        const first = d.split('(')[0].trim();
        const abbr = first.substring(0, 3).toLowerCase();
        const dayMap = {
          mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
          thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
        };
        return dayMap[abbr];
      })
      .filter(Boolean);

    for (const day of dayList) {
      if (day) hours[day] = { open, close };
    }
  }

  return hours;
}

/**
 * Check if current time is within business hours
 * @param {object} client - Client object with timezone and business_hours
 * @returns {boolean} True if within business hours
 */
function isWithinBusinessHours(client) {
  if (!client || !client.business_hours) return true; // default to open if no client or no business hours configured

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: client.timezone || 'America/New_York',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const dayPart = parts.find(p => p.type === 'weekday');
  const hourPart = parts.find(p => p.type === 'hour');
  const minPart = parts.find(p => p.type === 'minute');

  const day = dayPart?.value;
  const currentHour = parseInt(hourPart?.value || '0', 10);
  const currentMin = parseInt(minPart?.value || '0', 10);
  const currentTime = currentHour + currentMin / 60;

  const hours = parseBusinessHours(client.business_hours);
  const dayHours = hours[day];

  if (!dayHours) return false; // closed (Sunday or custom closure)
  return currentTime >= dayHours.open && currentTime < dayHours.close;
}

/**
 * Get next business hour (start of next business day if after hours)
 * @param {object} client - Client object
 * @returns {string} ISO timestamp of next open time
 */
function getNextBusinessHour(client) {
  if (!client) return new Date().toISOString();

  const tz = client.timezone || 'America/New_York';
  const hours = parseBusinessHours(client.business_hours);

  // Start with tomorrow
  let checkDate = new Date();
  checkDate.setDate(checkDate.getDate() + 1);

  // Find next open day (max 14 days search)
  for (let i = 0; i < 14; i++) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
    });
    const day = formatter.format(checkDate);
    const dayHours = hours[day];

    if (dayHours) {
      // Found an open day — set to opening time
      const nextDate = new Date(checkDate);
      nextDate.setHours(dayHours.open, 0, 0, 0);

      // Convert to ISO in UTC by offsetting back
      const isoStr = nextDate.toISOString();
      return isoStr;
    }

    checkDate.setDate(checkDate.getDate() + 1);
  }

  // Fallback: tomorrow 8 AM
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(8, 0, 0, 0);
  return fallback.toISOString();
}

/**
 * Calculate delay until next business hour (or 0 if within hours)
 * @param {object} client - Client object
 * @returns {number} Delay in milliseconds (0 if within hours)
 */
function shouldDelayUntilBusinessHours(client) {
  if (isWithinBusinessHours(client)) return 0;

  const next = getNextBusinessHour(client);
  const now = new Date();
  const nextTime = new Date(next);
  const delay = nextTime.getTime() - now.getTime();

  return Math.max(0, delay);
}

module.exports = {
  isWithinBusinessHours,
  getNextBusinessHour,
  shouldDelayUntilBusinessHours,
  parseBusinessHours,
};
