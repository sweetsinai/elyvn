/**
 * Database Backup Utility
 * Creates SQLite backups and manages retention
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a backup of the SQLite database
 * @param {string} dbPath - Path to the SQLite database file
 * @returns {Promise<{success: boolean, backupPath?: string, error?: string}>}
 */
async function backupDatabase(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { success: false, error: 'Database path not found' };
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.backup.${timestamp}`;

    // Copy the database file synchronously
    fs.copyFileSync(dbPath, backupPath);

    console.log(`[backup] Created backup: ${backupPath}`);

    // Clean up old backups (keep last 5)
    cleanupOldBackups(dbPath);

    return { success: true, backupPath };
  } catch (err) {
    console.error('[backup] backupDatabase error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Remove old backup files, keeping only the latest N
 * @param {string} dbPath - Path to the SQLite database
 * @param {number} [keepCount=5] - Number of backups to keep
 */
function cleanupOldBackups(dbPath, keepCount = 5) {
  try {
    const dir = path.dirname(dbPath);
    const dbName = path.basename(dbPath);
    const pattern = `${dbName}.backup.`;

    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(pattern))
      .map(f => ({
        name: f,
        path: path.join(dir, f),
        time: fs.statSync(path.join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time); // newest first

    // Delete old backups
    for (let i = keepCount; i < files.length; i++) {
      try {
        fs.unlinkSync(files[i].path);
        console.log(`[backup] Deleted old backup: ${files[i].name}`);
      } catch (err) {
        console.error(`[backup] Failed to delete ${files[i].name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[backup] cleanupOldBackups error:', err.message);
  }
}

/**
 * Schedule periodic backups
 * @param {string} dbPath - Path to the SQLite database
 * @param {number} [intervalHours=24] - Backup interval in hours
 * @returns {NodeJS.Timeout} Interval handle for cleanup
 */
function scheduleBackups(dbPath, intervalHours = 24) {
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Run first backup immediately
  backupDatabase(dbPath).catch(err =>
    console.error('[backup] Initial backup failed:', err)
  );

  // Schedule recurring backups
  const handle = setInterval(() => {
    backupDatabase(dbPath).catch(err =>
      console.error('[backup] Scheduled backup failed:', err)
    );
  }, intervalMs);

  console.log(`[backup] Backups scheduled every ${intervalHours} hours`);
  return handle;
}

module.exports = { backupDatabase, scheduleBackups, cleanupOldBackups };
