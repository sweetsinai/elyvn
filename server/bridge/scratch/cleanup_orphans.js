/**
 * DB Integrity Cleanup Script
 * Finds and deletes orphaned rows that violate foreign key constraints.
 * This allows us to safely enable PRAGMA foreign_keys = ON.
 */
const { createDatabase } = require('../utils/dbAdapter');
const { logger } = require('../utils/logger');

async function cleanup() {
  const db = createDatabase();
  logger.info('[cleanup] Starting integrity check...');

  const tables = [
    { table: 'calls', col: 'client_id', ref: 'clients' },
    { table: 'leads', col: 'client_id', ref: 'clients' },
    { table: 'messages', col: 'client_id', ref: 'clients' },
    { table: 'messages', col: 'lead_id', ref: 'leads' },
    { table: 'followups', col: 'client_id', ref: 'clients' },
    { table: 'followups', col: 'lead_id', ref: 'leads' },
    { table: 'appointments', col: 'client_id', ref: 'clients' },
    { table: 'appointments', col: 'lead_id', ref: 'leads' },
    { table: 'campaigns', col: 'client_id', ref: 'clients' },
    { table: 'prospects', col: 'client_id', ref: 'clients' },
    { table: 'emails_sent', col: 'client_id', ref: 'clients' },
    { table: 'refresh_tokens', col: 'client_id', ref: 'clients' },
  ];

  let totalDeleted = 0;

  for (const { table, col, ref } of tables) {
    const orphans = await db.query(`
      SELECT COUNT(*) as count FROM ${table} 
      WHERE ${col} IS NOT NULL 
      AND ${col} NOT IN (SELECT id FROM ${ref})
    `, [], 'get');

    if (orphans.count > 0) {
      logger.warn(`[cleanup] Found ${orphans.count} orphans in ${table}.${col} (missing in ${ref})`);
      const result = await db.query(`
        DELETE FROM ${table} 
        WHERE ${col} IS NOT NULL 
        AND ${col} NOT IN (SELECT id FROM ${ref})
      `, [], 'run');
      totalDeleted += result.changes;
      logger.info(`[cleanup] Deleted ${result.changes} orphaned rows from ${table}`);
    }
  }

  logger.info(`[cleanup] Finished. Total orphans removed: ${totalDeleted}`);
  
  // Verify with PRAGMA foreign_key_check
  const violations = db.pragma('foreign_key_check');
  if (violations && violations.length > 0) {
    logger.error('[cleanup] Still have FK violations:', violations);
  } else {
    logger.info('[cleanup] Integrity verified. No FK violations remaining.');
  }

  db.close();
}

cleanup().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
