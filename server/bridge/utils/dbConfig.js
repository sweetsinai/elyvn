/**
 * Centralized database path resolution.
 *
 * Priority order:
 * 1. DATABASE_PATH env var (absolute or relative to cwd)
 * 2. /data/elyvn.db when running in a production container with a /data volume
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
  if (process.env.DATABASE_PATH) {
    const p = process.env.DATABASE_PATH;
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  if (process.env.NODE_ENV === 'production' && fs.existsSync('/data')) {
    return '/data/elyvn.db';
  }

  return path.resolve(__dirname, '../../mcp/elyvn.db');
}

module.exports = { getDatabasePath };
