/**
 * Audit Logging Utility
 * Tracks security-relevant events (auth failures, API access, data modifications)
 */

const { randomUUID } = require('crypto');

/**
 * Log an audit event to the database
 * @param {object} db - better-sqlite3 instance
 * @param {object} params - Audit event details
 * @param {string} params.clientId - Client ID (optional)
 * @param {string} params.userId - User ID (optional)
 * @param {string} params.action - Action name (required)
 * @param {string} params.resourceType - Resource type (optional)
 * @param {string} params.resourceId - Resource ID (optional)
 * @param {string} params.ip - IP address (optional)
 * @param {string} params.userAgent - User agent (optional)
 * @param {any} params.details - Additional details as string or object
 */
function logAudit(db, { clientId, userId, action, resourceType, resourceId, ip, userAgent, details }) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO audit_log (id, client_id, user_id, action, resource_type, resource_id, ip_address, user_agent, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      randomUUID(),
      clientId || null,
      userId || null,
      action,
      resourceType || null,
      resourceId || null,
      ip || null,
      userAgent || null,
      typeof details === 'string' ? details : JSON.stringify(details)
    );
  } catch (err) {
    console.error('[audit] Log error:', err.message);
  }
}

module.exports = { logAudit };
