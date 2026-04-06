/**
 * Audit Logging Utility
 * Tracks security-relevant events (auth failures, API access, data modifications)
 * Includes sanitization, validation, fallback file logging, and retention management
 */

const { randomUUID } = require('crypto');
const fs = require('fs');

// auditLog.js is the fallback logger itself — use console directly
// (setupLogger() overrides console methods to also write to log files)
const logger = {
  info: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
};

const FALLBACK_LOG = process.env.AUDIT_FALLBACK_LOG || '/tmp/elyvn-audit-fallback.log';
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

// Valid audit actions — allowlisting
const VALID_ACTIONS = new Set([
  'auth_success', 'auth_failure', 'lead_created', 'lead_updated', 'lead_completed',
  'call_started', 'call_completed', 'sms_sent', 'sms_received', 'email_sent',
  'settings_changed', 'client_created', 'client_updated', 'brain_decision',
  'speed_lead_triggered', 'webhook_received', 'isolation_violation',
  'job_completed', 'job_failed', 'rate_limited', 'webhook_signature_invalid'
]);

/**
 * Sanitize details to prevent log injection and limit size
 * @param {any} details - Details object or string
 * @returns {string|null} Sanitized JSON string or null
 */
function sanitizeDetails(details) {
  if (!details) return null;
  try {
    const str = typeof details === 'string' ? details : JSON.stringify(details);
    // Remove control characters except newlines, limit to 5000 chars
    return str.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '').slice(0, 5000);
  } catch (e) {
    return String(details).slice(0, 5000);
  }
}

/**
 * Validate action against allowlist
 * @param {string} action - Action name
 * @returns {object} { action, isUnknown }
 */
function validateAction(action) {
  if (!action || typeof action !== 'string') {
    return { action: 'unknown:invalid_action', isUnknown: true };
  }
  if (VALID_ACTIONS.has(action)) {
    return { action, isUnknown: false };
  }
  return { action, isUnknown: true };
}

/**
 * Fallback file logging when DB write fails, with rotation support
 * @param {object} entry - Audit log entry
 */
function fallbackLog(entry) {
  try {
    // Check if log exists and exceeds max size
    if (fs.existsSync(FALLBACK_LOG)) {
      const stats = fs.statSync(FALLBACK_LOG);
      if (stats.size > MAX_LOG_SIZE) {
        // Rotate: move current to .old, discarding previous .old
        const oldPath = FALLBACK_LOG + '.old';
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
        fs.renameSync(FALLBACK_LOG, oldPath);
        logger.info(`[audit] Rotated fallback log at ${FALLBACK_LOG} (was ${Math.round(stats.size / 1048576)}MB)`);
      }
    }
    fs.appendFileSync(FALLBACK_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    logger.error('[audit] Fallback log write failed:', e.message);
  }
}

/**
 * Clean up audit log entries older than retention period
 * @param {object} db - better-sqlite3 instance
 * @param {number} retentionDays - Number of days to retain (default 90)
 * @returns {number} Number of entries deleted
 */
function cleanupAuditLog(db, retentionDays = 90) {
  if (!db) return 0;
  try {
    const result = db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')").run(retentionDays);
    logger.info(`[audit] Cleaned up ${result.changes} entries older than ${retentionDays} days`);
    return result.changes;
  } catch (e) {
    logger.error('[audit] Cleanup failed:', e.message);
    return 0;
  }
}

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

  // Validate and sanitize inputs
  const { action: validatedAction, isUnknown } = validateAction(action);
  const sanitizedDetails = sanitizeDetails(details);

  const entry = {
    id: randomUUID(),
    client_id: clientId || null,
    user_id: userId || null,
    action: validatedAction,
    resource_type: resourceType || null,
    resource_id: resourceId || null,
    ip_address: ip || null,
    user_agent: userAgent || null,
    details: sanitizedDetails,
    _unknown_action: isUnknown || null,
    created_at: new Date().toISOString(),
  };

  // Log warning if unknown action detected
  if (isUnknown) {
    logger.warn(`[audit] Unknown action detected: ${action}`);
  }

  try {
    db.prepare(`
      INSERT INTO audit_log (id, client_id, user_id, action, resource_type, resource_id, ip_address, user_agent, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.client_id,
      entry.user_id,
      entry.action,
      entry.resource_type,
      entry.resource_id,
      entry.ip_address,
      entry.user_agent,
      entry.details,
      entry.created_at
    );
  } catch (err) {
    logger.error('[audit] Log error:', err.message);
    // Fallback to file logging on DB failure
    fallbackLog(entry);
  }
}

module.exports = { logAudit, sanitizeDetails, validateAction, fallbackLog, cleanupAuditLog };
