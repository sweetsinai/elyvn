/**
 * Centralized database path resolution.
 *
 * Priority order:
 * 1. DATABASE_PATH env var (absolute or relative to cwd)
 * 2. /data/elyvn.db when a writable /data volume is present (production/Docker)
 * 3. Local development fallback: ../../mcp/elyvn.db relative to this file
 */

const path = require('path');
const fs = require('fs');

/**
 * Resolve the SQLite database file path.
 * Calling this function is idempotent — it reads env/fs at call time so tests
 * can override process.env before calling.
 *
 * @returns {string} Absolute path to the SQLite database file
 */
function getDatabasePath() {
  // Explicitly defined path takes priority
  if (process.env.DATABASE_PATH) {
    const p = process.env.DATABASE_PATH;
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  // Priority 1: Persistent data volume (Railway/Docker)
  // Check if /data exists and is writable
  if (fs.existsSync('/data')) {
    try {
      // In some environments /data might exist but not be writable by the current user.
      // Dockerfile ensures we run as root, but this check provides extra resilience.
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/elyvn.db';
    } catch (e) {
      // Fallback if /data is not writable
    }
  }

  // Priority 2: Local development fallback
  // Path is always relative to the project root for consistency.
  // Resolves to [project_root]/server/mcp/elyvn.db
  return path.resolve(__dirname, '../../mcp/elyvn.db');
}

module.exports = { getDatabasePath };
