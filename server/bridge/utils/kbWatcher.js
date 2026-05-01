'use strict';

/**
 * Knowledge Base Watcher
 * 
 * Watches the server/mcp/knowledge_bases/ directory for file changes.
 * When a .json file (named after a clientId) is modified, it automatically
 * triggers a sync to the Retell AI agent for that client.
 */

const fs = require('fs');
const path = require('path');
const { getKBRoot } = require('./dbConfig');
const { logger } = require('./logger');
const { syncClientToRetell } = require('./retellSync');
const { isValidUUID } = require('./validators');

// In-memory debounce to avoid double-syncing on rapid file writes
const debounceMap = new Map();
let watcher = null;

/**
 * Initialize the knowledge base file watcher.
 * @param {object} db - better-sqlite3 database instance
 */
function initKBWatcher(db) {
  if (watcher) return; // Already watching

  const KB_DIR = getKBRoot();
  logger.info(`[kbWatcher] Starting watcher for ${KB_DIR}`);

  try {
    watcher = fs.watch(KB_DIR, (eventType, filename) => {
      if (eventType === 'change' && filename && filename.endsWith('.json')) {
        const clientId = filename.replace('.json', '');
        
        if (!isValidUUID(clientId)) {
          return; // Ignore non-client JSON files
        }

        // Debounce: wait 1 second after last change before syncing
        if (debounceMap.has(clientId)) {
          clearTimeout(debounceMap.get(clientId));
        }

        const timeout = setTimeout(async () => {
          debounceMap.delete(clientId);
          logger.info(`[kbWatcher] Detected change in ${filename}, syncing to Retell...`);
          
          try {
            const result = await syncClientToRetell(clientId, db);
            if (result && result.success) {
              logger.info(`[kbWatcher] Auto-sync successful for ${clientId}`);
            } else {
              logger.warn(`[kbWatcher] Auto-sync failed for ${clientId}: ${result?.error || 'Unknown error'}`);
            }
          } catch (err) {
            logger.error(`[kbWatcher] Auto-sync error for ${clientId}:`, err.message);
          }
        }, 1000);

        debounceMap.set(clientId, timeout);
      }
    });
  } catch (err) {
    logger.error('[kbWatcher] Failed to start watcher:', err.message);
  }
}

/**
 * Stop the knowledge base file watcher.
 */
function stopKBWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    logger.info('[kbWatcher] Watcher stopped');
  }
  for (const timeout of debounceMap.values()) {
    clearTimeout(timeout);
  }
  debounceMap.clear();
}

module.exports = { initKBWatcher, stopKBWatcher };
