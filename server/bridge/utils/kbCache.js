const fs = require('fs');
const path = require('path');

const kbCache = new Map();
const KB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 1000;
const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB

// P1: Pending reads deduplication — prevents concurrent file reads for same clientId
const pendingReads = new Map();

// P1: Size tracking
let totalCacheBytes = 0;

/**
 * Evict the LRU entry (oldest accessedAt) to free space.
 */
function evictLRU() {
  let oldestKey = null;
  let oldestTime = Infinity;
  for (const [key, entry] of kbCache) {
    if (entry.accessedAt < oldestTime) {
      oldestTime = entry.accessedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) {
    const entry = kbCache.get(oldestKey);
    totalCacheBytes -= Buffer.byteLength(entry.content, 'utf8');
    kbCache.delete(oldestKey);
  }
}

/**
 * Load a client's knowledge base file with in-memory caching.
 * @param {string} clientId
 * @returns {Promise<string>} KB content or empty string
 */
async function loadKnowledgeBase(clientId) {
  const cached = kbCache.get(clientId);
  if (cached && Date.now() - cached.loadedAt < KB_CACHE_TTL) {
    // P1: Update accessedAt on every cache hit
    cached.accessedAt = Date.now();
    return cached.content;
  }

  // P1: Deduplicate concurrent reads — if a read is already in flight, reuse its promise
  if (pendingReads.has(clientId)) {
    return pendingReads.get(clientId);
  }

  const readPromise = (async () => {
    const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${clientId}.json`);
    try {
      const content = await fs.promises.readFile(kbPath, 'utf8');
      const entryBytes = Buffer.byteLength(content, 'utf8');

      // P1: Size-based eviction — evict LRU entries until there's room
      while (
        (kbCache.size >= MAX_ENTRIES || totalCacheBytes + entryBytes > MAX_CACHE_BYTES) &&
        kbCache.size > 0
      ) {
        evictLRU();
      }

      const now = Date.now();
      kbCache.set(clientId, { content, loadedAt: now, accessedAt: now });
      totalCacheBytes += entryBytes;
      return content;
    } catch (_) {
      return '';
    }
  })().finally(() => pendingReads.delete(clientId));

  pendingReads.set(clientId, readPromise);
  return readPromise;
}

/**
 * Invalidate a single client's cache entry.
 * @param {string} clientId
 */
function invalidateKBCache(clientId) {
  const entry = kbCache.get(clientId);
  if (entry) {
    totalCacheBytes -= Buffer.byteLength(entry.content, 'utf8');
    kbCache.delete(clientId);
  }
}

/**
 * Clear the entire KB cache.
 */
function clearKBCache() {
  kbCache.clear();
  totalCacheBytes = 0;
}

module.exports = { loadKnowledgeBase, invalidateKBCache, clearKBCache };
