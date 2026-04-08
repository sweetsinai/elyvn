'use strict';

/**
 * Get delay in ms until the next occurrence of a specific hour (local time)
 * @param {number} hour - Hour of day (0-23)
 * @param {number} minute - Minute (0-59), default 0
 * @returns {number} milliseconds until next occurrence
 */
function getDelayUntilHour(hour, minute = 0) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * Get delay in ms until the next occurrence of a day of week at a specific hour
 * @param {number} targetDay - Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
 * @param {number} hour - Hour of day (0-23)
 * @param {number} minute - Minute (0-59)
 * @returns {number} milliseconds until next occurrence
 */
function getDelayUntilDayOfWeek(targetDay, hour = 0, minute = 0) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  const currentDay = now.getDay();
  let daysUntil = (targetDay - currentDay + 7) % 7;
  if (daysUntil === 0 && target <= now) {
    daysUntil = 7;
  }
  target.setDate(target.getDate() + daysUntil);
  return target.getTime() - now.getTime();
}

/**
 * Format delay for logging: "in 3h 24m"
 */
function formatDelay(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

module.exports = { getDelayUntilHour, getDelayUntilDayOfWeek, formatDelay };
