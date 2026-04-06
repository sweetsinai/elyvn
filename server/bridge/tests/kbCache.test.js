/**
 * Tests for utils/kbCache.js — knowledge base file caching
 */

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      readFile: jest.fn(),
    },
  };
});

describe('kbCache', () => {
  let loadKnowledgeBase, invalidateKBCache, clearKBCache;
  let fs;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      promises: {
        readFile: jest.fn(),
      },
    }));
    fs = require('fs');

    const kbCache = require('../utils/kbCache');
    loadKnowledgeBase = kbCache.loadKnowledgeBase;
    invalidateKBCache = kbCache.invalidateKBCache;
    clearKBCache = kbCache.clearKBCache;
  });

  afterEach(() => {
    clearKBCache();
  });

  test('first load reads from disk', async () => {
    fs.promises.readFile.mockResolvedValue('{"faq": "answer"}');

    const result = await loadKnowledgeBase('client-1');
    expect(result).toBe('{"faq": "answer"}');
    expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.readFile).toHaveBeenCalledWith(
      expect.stringContaining('client-1.json'),
      'utf8'
    );
  });

  test('second load within TTL returns cached value (no disk read)', async () => {
    fs.promises.readFile.mockResolvedValue('{"cached": true}');

    await loadKnowledgeBase('client-2');
    await loadKnowledgeBase('client-2');

    expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
  });

  test('after TTL expiry reads from disk again', async () => {
    fs.promises.readFile.mockResolvedValue('v1');

    await loadKnowledgeBase('client-3');

    // Manipulate cache timestamp to simulate TTL expiry
    // Access internal cache by loading again after clearing with a time hack
    const origDateNow = Date.now;
    Date.now = () => origDateNow() + 6 * 60 * 1000; // 6 minutes later (TTL is 5 min)

    fs.promises.readFile.mockResolvedValue('v2');
    const result = await loadKnowledgeBase('client-3');

    expect(result).toBe('v2');
    expect(fs.promises.readFile).toHaveBeenCalledTimes(2);

    Date.now = origDateNow;
  });

  test('missing file returns empty string', async () => {
    fs.promises.readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadKnowledgeBase('nonexistent-client');
    expect(result).toBe('');
  });

  test('invalidateKBCache removes entry so next load reads disk', async () => {
    fs.promises.readFile.mockResolvedValue('data');

    await loadKnowledgeBase('client-4');
    invalidateKBCache('client-4');

    fs.promises.readFile.mockResolvedValue('new-data');
    const result = await loadKnowledgeBase('client-4');

    expect(result).toBe('new-data');
    expect(fs.promises.readFile).toHaveBeenCalledTimes(2);
  });

  test('clearKBCache clears all entries', async () => {
    fs.promises.readFile.mockResolvedValue('data-a');
    await loadKnowledgeBase('a');

    fs.promises.readFile.mockResolvedValue('data-b');
    await loadKnowledgeBase('b');

    clearKBCache();

    fs.promises.readFile.mockResolvedValue('data-a-new');
    await loadKnowledgeBase('a');

    fs.promises.readFile.mockResolvedValue('data-b-new');
    await loadKnowledgeBase('b');

    // 2 initial + 2 after clear = 4
    expect(fs.promises.readFile).toHaveBeenCalledTimes(4);
  });
});
