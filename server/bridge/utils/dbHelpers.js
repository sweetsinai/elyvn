'use strict';

/**
 * Check if a lead has reached a terminal stage (booked or completed)
 */
function isLeadComplete(lead) {
  return lead && ['booked', 'completed'].includes(lead.stage);
}

/**
 * Get count of records since a date for a client
 */
const ALLOWED_TABLES = new Set(['leads', 'calls', 'messages', 'appointments', 'followups', 'emails_sent']);

function getCountSince(db, table, clientId, since) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Invalid table: ${table}`);
  return db.prepare(
    `SELECT COUNT(*) as count FROM ${table} WHERE client_id = ? AND created_at >= ?`
  ).get(clientId, since).count;
}

/**
 * Get the start of the current week (Monday)
 */
function getStartOfWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

/**
 * Get the start of last week (Monday)
 */
function getStartOfLastWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1) - 7;
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

/**
 * Standard pagination parser with bounds checking
 */
function parsePagination(query, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

module.exports = { isLeadComplete, getCountSince, getStartOfWeek, getStartOfLastWeek, parsePagination };
