/**
 * Database Backup Utility
 * Creates SQLite backups and manages retention with WAL checkpoint
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a backup of the SQLite database
 * Ensures WAL data is flushed before backup via checkpoint
 * @param {string} dbPath - Path to the SQLite database file
 * @param {object} [db] - Optional database connection for WAL checkpoint
 * @returns {Promise<{success: boolean, backupPath?: string, error?: string}>}
 */
async function backupDatabase(dbPath, db) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { success: false, error: 'Database path not found' };
  }

  try {
    // Step 1: Checkpoint WAL to ensure all data is in main DB file
    // This is critical for live database backups with WAL mode
    if (db) {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        console.log('[backup] WAL checkpoint completed (TRUNCATE)');
      } catch (err) {
        console.warn('[backup] WAL checkpoint failed (non-fatal):', err.message);
        // Continue with backup attempt even if checkpoint fails
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.backup.${timestamp}`;

    // Step 2: Use better-sqlite3 backup API if available, otherwise fall back to fs.copyFileSync
    if (db && typeof db.backup === 'function') {
      try {
        db.backup(backupPath);
        console.log(`[backup] Created backup using db.backup() API: ${backupPath}`);
      } catch (err) {
        console.warn('[backup] db.backup() failed, falling back to fs.copyFileSync:', err.message);
        fs.copyFileSync(dbPath, backupPath);
        console.log(`[backup] Created backup using fs.copyFileSync: ${backupPath}`);
      }
    } else {
      // Fallback: copy the database file synchronously
      fs.copyFileSync(dbPath, backupPath);
      console.log(`[backup] Created backup using fs.copyFileSync: ${backupPath}`);
    }

    // Clean up old backups (keep last 7)
    cleanupOldBackups(dbPath, 7);

    return { success: true, backupPath };
  } catch (err) {
    console.error('[backup] backupDatabase error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Remove old backup files, keeping only the latest N
 * @param {string} dbPath - Path to the SQLite database
 * @param {number} [keepCount=7] - Number of backups to keep (default: 7 days worth)
 */
function cleanupOldBackups(dbPath, keepCount = 7) {
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
 * @param {object} [db] - Optional database connection for WAL checkpoint
 * @returns {NodeJS.Timeout} Interval handle for cleanup
 */
function scheduleBackups(dbPath, intervalHours = 24, db) {
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Run first backup immediately
  backupDatabase(dbPath, db).catch(err =>
    console.error('[backup] Initial backup failed:', err)
  );

  // Schedule recurring backups
  const handle = setInterval(() => {
    backupDatabase(dbPath, db).catch(err =>
      console.error('[backup] Scheduled backup failed:', err)
    );
  }, intervalMs);

  console.log(`[backup] Backups scheduled every ${intervalHours} hours (with WAL checkpoint and rotation)`);
  return handle;
}

module.exports = { backupDatabase, scheduleBackups, cleanupOldBackups };
