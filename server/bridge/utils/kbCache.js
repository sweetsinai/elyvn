const fs = require('fs');
const path = require('path');

const kbCache = new Map();
const KB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 1000;

/**
 * Load a client's knowledge base file with in-memory caching.
 * @param {string} clientId
 * @returns {Promise<string>} KB content or empty string
 */
async function loadKnowledgeBase(clientId) {
  const cached = kbCache.get(clientId);
  if (cached && Date.now() - cached.loadedAt < KB_CACHE_TTL) {
    return cached.content;
  }
  const kbPath = path.join(__dirname, '../../mcp/knowledge_bases', `${clientId}.json`);
  try {
    const content = await fs.promises.readFile(kbPath, 'utf8');
    // Evict oldest entry if cache is full (simple LRU)
    if (kbCache.size >= MAX_ENTRIES) {
      const oldestKey = kbCache.keys().next().value;
      kbCache.delete(oldestKey);
    }
    kbCache.set(clientId, { content, loadedAt: Date.now() });
    return content;
  } catch (_) {
    return '';
  }
}

/**
 * Invalidate a single client's cache entry.
 * @param {string} clientId
 */
function invalidateKBCache(clientId) {
  kbCache.delete(clientId);
}

/**
 * Clear the entire KB cache.
 */
function clearKBCache() {
  kbCache.clear();
}

module.exports = { loadKnowledgeBase, invalidateKBCache, clearKBCache };
