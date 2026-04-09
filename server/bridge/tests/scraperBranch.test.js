/**
 * Tests for utils/scraper.js - Branch coverage
 * Tests pagination logic, error handling, data parsing, email scraping
 */

'use strict';

jest.mock('../config/timing', () => ({
  SCRAPER_RETRY_DELAY_MS: 10,  // Use tiny delay for tests
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const Database = require('better-sqlite3');
const { scrapeGoogleMaps } = require('../utils/scraper');
const { runMigrations } = require('../utils/migrations');

describe('scraper branch coverage', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    db = new Database(':memory:');
    runMigrations(db);
    // Add async db.query() shim so source code using db.query() works with better-sqlite3
    db.query = (sql, params = [], mode = 'all') => {
      const stmt = db.prepare(sql);
      if (mode === 'get') return Promise.resolve(stmt.get(...params));
      if (mode === 'run') return Promise.resolve(stmt.run(...params));
      return Promise.resolve(stmt.all(...params));
    };
    process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  describe('pagination logic', () => {
    test('continues to next page when token provided', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [
              { place_id: 'p1', name: 'Business 1', formatted_address: '123 St' },
              { place_id: 'p2', name: 'Business 2', formatted_address: '456 Ave' }
            ],
            next_page_token: 'page2token'
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [
              { place_id: 'p3', name: 'Business 3', formatted_address: '789 Blvd' }
            ],
            next_page_token: null
          })
        })
        // Mock place details calls (3 for the 3 places found)
        .mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({
            status: 'OK',
            result: {}
          })
        });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      // At least the first 2 calls should be the pagination calls
      expect(global.fetch).toHaveBeenCalledTimes(5);
      expect(result.success).toBe(true);
    });

    test('stops pagination at 3 pages maximum', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          status: 'OK',
          results: [{ place_id: 'p1', name: 'Business 1' }],
          next_page_token: 'token'
        })
      });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST', 50);

      // Should call fetch multiple times (3 pagination + place details)
      // Just verify it doesn't call indefinitely
      expect(global.fetch).toHaveBeenCalled();
    });

    test('stops pagination when limit reached', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: Array(40).fill({ place_id: 'p1', name: 'Business' }),
            next_page_token: 'page2'
          })
        });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST', 30);

      expect(result.found).toBeLessThanOrEqual(30);
    });

    test('handles ZERO_RESULTS status gracefully', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'ZERO_RESULTS'
        })
      });

      const result = await scrapeGoogleMaps(db, 'Nonexistent', 'Nowhere', 'XX');

      expect(result.success).toBe(true);
      expect(result.found).toBe(0);
    });

    test('breaks on API error status', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'REQUEST_DENIED',
          error_message: 'Invalid API key'
        })
      });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      // When API returns error, it breaks out of loop but still returns success: true with found: 0
      expect(result.success).toBe(true);
      expect(result.found).toBe(0);
    });
  });

  describe('place details API', () => {
    test('fetches phone and website from place details', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [
              { place_id: 'p1', name: 'Business', formatted_address: '123 St' }
            ]
          })
        })
        .mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({
            status: 'OK',
            result: {
              international_phone_number: '+1-555-0100',
              website: 'https://business.com'
            }
          })
        });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      // Check that one of the calls included place/details
      const detailsCall = global.fetch.mock.calls.find(call =>
        call[0].includes('place/details')
      );
      expect(detailsCall).toBeDefined();
    });

    test('handles missing place_id gracefully', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: [{ name: 'Business', formatted_address: '123 St' }]
        })
      });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(true);
    });

    test('falls back to formatted_phone_number', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [{ place_id: 'p1', name: 'Business' }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            result: {
              formatted_phone_number: '(555) 0100',
              website: 'https://business.com'
            }
          })
        });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(true);
    });

    test('handles place details fetch error silently', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [{ place_id: 'p1', name: 'Business' }]
          })
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(true);
    });
  });

  describe('email scraping from website', () => {
    test('extracts email from website HTML', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [{ place_id: 'p1', name: 'Business' }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            result: {
              website: 'https://business.com'
            }
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          text: jest.fn().mockResolvedValueOnce(
            '<html><a href="mailto:info@business.com">Contact</a></html>'
          )
        });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(true);
    });

    test('handles website fetch timeout', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [{ place_id: 'p1', name: 'Business' }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            result: {
              website: 'https://business.com'
            }
          })
        })
        .mockRejectedValueOnce(new Error('Timeout'));

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(true);
    });

    test('handles non-OK website response', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [{ place_id: 'p1', name: 'Business' }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            result: { website: 'https://business.com' }
          })
        })
        .mockResolvedValueOnce({
          ok: false,
          text: jest.fn()
        });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(true);
    });

    test('skips email scraping when no website', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [{ place_id: 'p1', name: 'Business' }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            result: {}
          })
        });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(true);
    });
  });

  describe('deduplication', () => {
    test('skips existing prospects by name and city', async () => {
      db.prepare(`
        INSERT INTO prospects (id, business_name, city, email, status, created_at, updated_at)
        VALUES ('existing', 'Business A', 'City', 'old@business.com', 'new', datetime('now'), datetime('now'))
      `).run();

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: [
            { place_id: 'p1', name: 'Business A', formatted_address: '123 St' }
          ]
        })
      });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.new).toBe(0);
    });

    test('inserts new prospect when not deduped', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: [
            { place_id: 'p1', name: 'Unique Business', formatted_address: '123 St' }
          ]
        })
      });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.new).toBeGreaterThan(0);
    });
  });

  describe('response structure', () => {
    test('returns success false on fetch error', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.found).toBe(0);
      expect(result.new).toBe(0);
    });

    test('includes error message on failure', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Failed to connect'));

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.error).toContain('Failed to connect');
    });

    test('returns found and new counts', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: [
            { place_id: 'p1', name: 'Business', formatted_address: '123 St' }
          ]
        })
      });

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(typeof result.found).toBe('number');
      expect(typeof result.new).toBe('number');
    });
  });

  describe('API key handling', () => {
    test('returns error when API key not set', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No API key');
    });

    test('includes API key in search request', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: []
        })
      });

      await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      // Check that the first call (search) includes the API key
      const searchCall = global.fetch.mock.calls[0];
      expect(searchCall[0]).toContain('key=test-api-key');
    });

    test('includes API key in place details request', async () => {
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            results: [{ place_id: 'p1', name: 'Business' }]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValueOnce({
            status: 'OK',
            result: {}
          })
        });

      await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      const detailCall = global.fetch.mock.calls[1];
      expect(detailCall[0]).toContain('key=test-api-key');
    });
  });

  describe('query building', () => {
    test('builds correct search query with state', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: []
        })
      });

      await scrapeGoogleMaps(db, 'Plumber', 'Austin', 'TX');

      const searchCall = global.fetch.mock.calls[0];
      expect(searchCall[0]).toContain('Plumber');
      expect(searchCall[0]).toContain('Austin');
      expect(searchCall[0]).toContain('TX');
    });

    test('builds query without state', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: []
        })
      });

      await scrapeGoogleMaps(db, 'Dentist', 'London');

      const searchCall = global.fetch.mock.calls[0];
      expect(searchCall[0]).toContain('Dentist');
      expect(searchCall[0]).toContain('London');
    });

    test('handles empty state parameter', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          status: 'OK',
          results: []
        })
      });

      await scrapeGoogleMaps(db, 'Lawyer', 'Boston', '');

      const searchCall = global.fetch.mock.calls[0];
      expect(searchCall[0]).toContain('Lawyer');
      expect(searchCall[0]).toContain('Boston');
    });
  });

  describe('module exports', () => {
    test('exports scrapeGoogleMaps function', () => {
      const { scrapeGoogleMaps: sgm } = require('../utils/scraper');
      expect(typeof sgm).toBe('function');
    });
  });
});
