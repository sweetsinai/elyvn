/**
 * Centralized database and storage path resolution.
 *
 * Priority order for data root:
 * 1. DATA_ROOT env var (absolute or relative to cwd)
 * 2. /data when a writable /data volume is present (production/Docker)
 * 3. Local development fallback: [project_root]/server/mcp
 */

const path = require('path');
const fs = require('fs');

/**
 * Resolve the root directory for persistent data.
 * 
 * @returns {string} Absolute path to the data root
 */
function getDataRoot() {
  // Explicitly defined root takes priority
  if (process.env.DATA_ROOT) {
    const p = process.env.DATA_ROOT;
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  // Priority 1: Persistent data volume (Railway/Docker)
  // Check if /data exists and is writable
  if (fs.existsSync('/data')) {
    try {
      // In some environments /data might exist but not be writable by the current user.
      // Dockerfile ensures we run as root, but this check provides extra resilience.
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data';
    } catch (e) {
      // Fallback if /data is not writable
    }
  }

  // Priority 2: Local development fallback
  // Resolves to [project_root]/server/mcp
  const localMcp = path.resolve(__dirname, '../../mcp');
  if (fs.existsSync(localMcp)) {
    return localMcp;
  }

  // Final fallback to current directory mcp if for some reason it's moved
  return path.resolve(process.cwd(), 'mcp');
}

/**
 * Resolve the SQLite database file path.
 *
 * @returns {string} Absolute path to the SQLite database file
 */
function getDatabasePath() {
  if (process.env.DATABASE_PATH) {
    const p = process.env.DATABASE_PATH;
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  return path.join(getDataRoot(), 'elyvn.db');
}

/**
 * Resolve the root directory for Knowledge Bases.
 * Ensures the directory exists.
 * 
 * @returns {string} Absolute path to the KB root
 */
function getKBRoot() {
  const root = getDataRoot();
  const kbPath = path.join(root, 'knowledge_bases');
  
  if (!fs.existsSync(kbPath)) {
    try {
      fs.mkdirSync(kbPath, { recursive: true });
    } catch (e) {
      // Silent fail - if we can't create it, subsequent file operations will fail with clear errors
    }
  }
  
  return kbPath;
}

module.exports = { 
  getDataRoot, 
  getDatabasePath, 
  getKBRoot 
};
