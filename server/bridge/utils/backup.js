/**
 * Database Backup Utility
 * Creates SQLite backups and manages retention with WAL checkpoint
 */

const fs = require('fs');
const path = require('path');

// Lazy-load logger — backup.js may run before logger is initialized
function getLogger() {
  try { return require('./logger').logger; }
  catch { return { info: (m) => process.stdout.write(`[INFO] ${m}\n`), error: (m) => process.stderr.write(`[ERROR] ${m}\n`), warn: (m) => process.stderr.write(`[WARN] ${m}\n`), debug: () => {} }; }
}

/**
 * Upload a file to S3/R2
 */
async function uploadToS3(filePath, fileName) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { Upload } = require('@aws-sdk/lib-storage');
  
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || 'auto';
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const endpoint = process.env.S3_ENDPOINT; // For R2/Wasabi/Minio

  if (!bucket || !accessKeyId || !secretAccessKey) {
    getLogger().info('[backup] S3 credentials not fully configured — skipping remote upload');
    return;
  }

  try {
    const s3 = new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: !!endpoint,
    });

    const fileStream = fs.createReadStream(filePath);
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: `backups/${fileName}`,
        Body: fileStream,
      },
    });

    await upload.done();
    getLogger().info(`[backup] Successfully uploaded to S3: backups/${fileName}`);
  } catch (err) {
    getLogger().error('[backup] S3 upload failed:', err.message);
    throw err;
  }
}

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
        getLogger().info('[backup] WAL checkpoint completed (TRUNCATE)');
      } catch (err) {
        getLogger().warn('[backup] WAL checkpoint failed (non-fatal):', err.message);
        // Continue with backup attempt even if checkpoint fails
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.backup.${timestamp}`;

    // Step 2: Use better-sqlite3 backup API if available, otherwise fall back to fs.copyFileSync
    if (db && typeof db.backup === 'function') {
      try {
        db.backup(backupPath);
        getLogger().info(`[backup] Created backup using db.backup() API: ${backupPath}`);
      } catch (err) {
        getLogger().warn('[backup] db.backup() failed, falling back to fs.copyFileSync:', err.message);
        fs.copyFileSync(dbPath, backupPath);
        getLogger().info(`[backup] Created backup using fs.copyFileSync: ${backupPath}`);
      }
    } else {
      // Fallback: copy the database file synchronously
      fs.copyFileSync(dbPath, backupPath);
      getLogger().info(`[backup] Created backup using fs.copyFileSync: ${backupPath}`);
    }

    // Clean up old backups (keep last 7)
    cleanupOldBackups(dbPath, 7);

    // Step 3: Remote upload
    const fileName = path.basename(backupPath);
    await uploadToS3(backupPath, fileName).catch(err => {
      getLogger().error('[backup] Remote upload failed:', err.message);
    });

    return { success: true, backupPath };
  } catch (err) {
    getLogger().error('[backup] backupDatabase error:', err.message);
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
        getLogger().info(`[backup] Deleted old backup: ${files[i].name}`);
      } catch (err) {
        getLogger().error(`[backup] Failed to delete ${files[i].name}:`, err.message);
      }
    }
  } catch (err) {
    getLogger().error('[backup] cleanupOldBackups error:', err.message);
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
    getLogger().error('[backup] Initial backup failed:', err)
  );

  // Schedule recurring backups with failure alerting
  const handle = setInterval(async () => {
    const result = await backupDatabase(dbPath, db).catch(err => {
      getLogger().error('[backup] Scheduled backup failed:', err);
      return { success: false, error: err.message };
    });

    // Alert on failure via Telegram (so owner knows backups are broken)
    if (!result.success) {
      try {
        const { alertCriticalError } = require('./alert');
        if (alertCriticalError) alertCriticalError('backup.scheduled', new Error(`Backup failed: ${result.error}`));
      } catch (_) {}
    }
  }, intervalMs);

  getLogger().info(`[backup] Backups scheduled every ${intervalHours} hours (with WAL checkpoint and rotation)`);
  return handle;
}

module.exports = { backupDatabase, scheduleBackups, cleanupOldBackups };
