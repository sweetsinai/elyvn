/**
 * Audit Logging Utility
 * Tracks security-relevant events (auth failures, API access, data modifications)
 * Includes sanitization, validation, fallback file logging, and retention management
 */

const { randomUUID, createHash } = require('crypto');
const fs = require('fs');

// Lazy-load logger — auditLog.js may initialize before logger
function getLogger() {
  try { return require('./logger').logger; }
  catch { return { info: (m) => process.stdout.write(`[INFO] ${m}\n`), error: (m) => process.stderr.write(`[ERROR] ${m}\n`), warn: (m) => process.stderr.write(`[WARN] ${m}\n`), debug: () => {} }; }
}

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
        getLogger().info(`[audit] Rotated fallback log at ${FALLBACK_LOG} (was ${Math.round(stats.size / 1048576)}MB)`);
      }
    }
    fs.appendFileSync(FALLBACK_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    getLogger().error('[audit] Fallback log write failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Tamper detection — chain-of-custody hashing
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash over an audit entry's stable fields plus the
 * previous entry's hash, forming a linked chain.
 * NOTE: `hash` and `previous_hash` are excluded from the input so the
 * computation is deterministic regardless of the stored columns.
 *
 * @param {object} entry - Audit entry (must not contain `hash` / `previous_hash`)
 * @param {string} previousHash - Hash of the immediately preceding entry, '' for first
 * @returns {string} hex digest
 */
function computeEntryHash(entry, previousHash = '') {
  // Build a stable, order-fixed representation excluding chain columns
  const { hash: _h, previous_hash: _ph, ...stable } = entry;
  const content = JSON.stringify({ ...stable, previousHash });
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Fetch the hash of the most-recently inserted audit_log row.
 * Returns '' when the table is empty (genesis entry).
 *
 * @param {object} db - better-sqlite3 / db wrapper
 * @returns {Promise<string>}
 */
async function getLatestHash(db) {
  try {
    const result = await db.query(
      "SELECT hash FROM audit_log WHERE hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [],
      'get'
    );
    return (result && result.hash) ? result.hash : '';
  } catch {
    return '';
  }
}

/**
 * Verify the integrity of the entire audit_log chain.
 * Entries are read in insertion order (created_at ASC, rowid ASC).
 * Rows that pre-date the tamper-detection migration (hash IS NULL) are skipped.
 *
 * @param {object} db - better-sqlite3 / db wrapper
 * @returns {Promise<{ valid: boolean, brokenAt?: string, checked: number }>}
 */
async function verifyAuditChain(db) {
  if (!db) throw new Error('[audit] verifyAuditChain requires a db instance');
  try {
    const entries = await db.query(
      "SELECT * FROM audit_log WHERE hash IS NOT NULL ORDER BY created_at ASC, rowid ASC",
      [],
      'all'
    );
    let expectedPreviousHash = '';
    for (const entry of entries) {
      const computed = computeEntryHash(entry, expectedPreviousHash);
      if (computed !== entry.hash) {
        return { valid: false, brokenAt: entry.id, checked: entries.indexOf(entry) };
      }
      expectedPreviousHash = entry.hash;
    }
    return { valid: true, checked: entries.length };
  } catch (err) {
    getLogger().error('[audit] verifyAuditChain error:', err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------

/**
 * Clean up audit log entries older than retention period
 * @param {object} db - better-sqlite3 instance
 * @param {number} retentionDays - Number of days to retain (default 90)
 * @returns {number} Number of entries deleted
 */
async function cleanupAuditLog(db, retentionDays = 90) {
  if (!db) return 0;
  try {
    const result = await db.query("DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')", [retentionDays], 'run');
    getLogger().info(`[audit] Cleaned up ${result.changes} entries older than ${retentionDays} days`);
    return result.changes;
  } catch (e) {
    getLogger().error('[audit] Cleanup failed:', e.message);
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
async function logAudit(db, { clientId, userId, action, resourceType, resourceId, ip, userAgent, details }) {
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
    getLogger().warn(`[audit] Unknown action detected: ${action}`);
  }

  // Tamper-detection chain hash
  const previousHash = await getLatestHash(db);
  const hash = computeEntryHash(entry, previousHash);

  try {
    await db.query(`
      INSERT INTO audit_log (id, client_id, user_id, action, resource_type, resource_id, ip_address, user_agent, details, created_at, hash, previous_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.id,
      entry.client_id,
      entry.user_id,
      entry.action,
      entry.resource_type,
      entry.resource_id,
      entry.ip_address,
      entry.user_agent,
      entry.details,
      entry.created_at,
      hash,
      previousHash || null
    ], 'run');
  } catch (err) {
    getLogger().error('[audit] Log error:', err.message);
    // Fallback to file logging on DB failure
    fallbackLog(entry);
  }
}

/**
 * Log a data mutation (UPDATE or DELETE) on a business record.
 * Records before/after values for full change history.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {object} params
 * @param {string} params.action       - e.g. 'lead_updated', 'lead_completed', 'settings_changed'
 * @param {string} params.table        - DB table name being mutated (e.g. 'leads', 'clients')
 * @param {string} params.recordId     - Primary key of the mutated record
 * @param {string} [params.clientId]   - Tenant client ID for scoping
 * @param {string} [params.userId]     - User/API key ID that triggered the change
 * @param {object} [params.oldValues]  - Snapshot of values before the mutation
 * @param {object} [params.newValues]  - Snapshot of values after the mutation (only changed fields needed)
 * @param {string} [params.ip]         - IP address (optional)
 */
async function logDataMutation(db, { action, table, recordId, clientId, userId, oldValues, newValues, ip }) {
  if (!db) return;

  const { action: validatedAction } = validateAction(action);

  const id = randomUUID();
  const now = new Date().toISOString();

  const serialiseValues = (val) => {
    if (!val) return null;
    try {
      return typeof val === 'string' ? val : JSON.stringify(val);
    } catch {
      return String(val);
    }
  };

  const oldValuesStr = serialiseValues(oldValues);
  const newValuesStr = serialiseValues(newValues);

  const entry = {
    id,
    client_id: clientId || null,
    user_id: userId || null,
    action: validatedAction,
    resource_type: table || null,
    resource_id: recordId || null,
    ip_address: ip || null,
    user_agent: null,
    details: null,
    old_values: oldValuesStr,
    new_values: newValuesStr,
    created_at: now,
  };

  try {
    await db.query(`
      INSERT INTO audit_log
        (id, client_id, user_id, action, resource_type, resource_id, ip_address, user_agent, details, old_values, new_values, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.id,
      entry.client_id,
      entry.user_id,
      entry.action,
      entry.resource_type,
      entry.resource_id,
      entry.ip_address,
      entry.user_agent,
      entry.details,
      entry.old_values,
      entry.new_values,
      entry.created_at
    ], 'run');
  } catch (err) {
    getLogger().error('[audit] logDataMutation error:', err.message);
    fallbackLog(entry);
  }
}

module.exports = { logAudit, logDataMutation, sanitizeDetails, validateAction, fallbackLog, cleanupAuditLog };
