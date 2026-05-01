'use strict';

const path = require('path');

/**
 * Join paths and verify the result is within the base directory.
 * Prevents path traversal attacks.
 * 
 * @param {string} baseDir - The trusted base directory
 * @param {string} ...parts - Path segments to join
 * @returns {string} The resolved absolute path
 * @throws {Error} If the resulting path is outside the base directory
 */
function joinSafe(baseDir, ...parts) {
  const resolvedBase = path.resolve(baseDir);
  const joined = path.join(resolvedBase, ...parts);
  const resolvedJoined = path.resolve(joined);

  if (!resolvedJoined.startsWith(resolvedBase)) {
    throw new Error('Path traversal attempt detected');
  }

  return resolvedJoined;
}

module.exports = { joinSafe };
