/**
 * Tests for scraper.js
 * Tests Google Maps scraping and prospect data collection
 */

const Database = require('better-sqlite3');
const { scrapeGoogleMaps } = require('../utils/scraper');
const { runMigrations } = require('../utils/migrations');

jest.mock('node-fetch');

describe('scraper', () => {
  let db;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(':memory:');
    runMigrations(db);

    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('scrapeGoogleMaps', () => {
    test('returns error when no API key configured', async () => {
      process.env.GOOGLE_MAPS_API_KEY = '';

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No API key');
      expect(result.found).toBe(0);
    });

    test('fetches and parses Google Maps results', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      const mockResponse = {
        status: 'OK',
        results: [
          {
            name: 'Sample Dental Co',
            place_id: 'place123',
            formatted_address: '123 Main St, NY',
            rating: 4.5,
            user_ratings_total: 42
          }
        ],
        next_page_token: null
      };

      global.fetch.mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockResponse),
        ok: true,
        status: 200
      });

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(result.success).toBe(true);
      expect(result.found).toBe(1);
    });

    test('fetches details for each place (phone, website)', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      const searchResponse = {
        status: 'OK',
        results: [
          {
            name: 'Sample Co',
            place_id: 'place123',
            formatted_address: '123 Main St',
            rating: 4.5,
            user_ratings_total: 42
          }
        ],
        next_page_token: null
      };

      const detailResponse = {
        result: {
          international_phone_number: '+1-212-555-1234',
          website: 'https://example.com'
        }
      };

      global.fetch.mockImplementation(async (url) => {
        if (url.includes('textsearch')) {
          return {
            json: jest.fn().mockResolvedValue(searchResponse),
            ok: true
          };
        } else if (url.includes('details')) {
          return {
            json: jest.fn().mockResolvedValue(detailResponse),
            ok: true
          };
        } else if (url.includes('example.com')) {
          return {
            ok: true,
            text: jest.fn().mockResolvedValue('<a href="mailto:contact@example.com">Email</a>')
          };
        }
      });

      await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('place/details')
      );
    });

    test('extracts email from website content', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      const searchResponse = {
        status: 'OK',
        results: [
          {
            name: 'Sample Co',
            place_id: 'place123',
            formatted_address: '123 Main St',
            rating: 4.5,
            user_ratings_total: 42
          }
        ],
        next_page_token: null
      };

      const detailResponse = {
        result: {
          website: 'https://example.com'
        }
      };

      global.fetch.mockImplementation(async (url) => {
        if (url.includes('textsearch')) {
          return {
            json: jest.fn().mockResolvedValue(searchResponse),
            ok: true
          };
        } else if (url.includes('details')) {
          return {
            json: jest.fn().mockResolvedValue(detailResponse),
            ok: true
          };
        } else if (url.includes('example.com')) {
          return {
            ok: true,
            text: jest.fn().mockResolvedValue('mailto:info@example.com')
          };
        }
      });

      await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      const prospect = db.prepare('SELECT * FROM prospects LIMIT 1').get();
      expect(prospect.email).toBe('info@example.com');
    });

    test('deduplicates by business_name and city', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      // Insert existing prospect
      db.prepare(`
        INSERT INTO prospects (id, business_name, city, status, created_at, updated_at)
        VALUES ('p1', 'Sample Co', 'New York', 'new', datetime('now'), datetime('now'))
      `).run();

      const searchResponse = {
        status: 'OK',
        results: [
          {
            name: 'Sample Co',
            place_id: 'place123',
            formatted_address: '123 Main St',
            rating: 4.5,
            user_ratings_total: 42
          }
        ],
        next_page_token: null
      };

      global.fetch.mockResolvedValue({
        json: jest.fn().mockResolvedValue(searchResponse),
        ok: true
      });

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(result.new).toBe(0);
    });

    test('respects result limit', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      const results = Array.from({ length: 60 }, (_, i) => ({
        name: `Co ${i}`,
        place_id: `place${i}`,
        formatted_address: `${i} Main St`,
        rating: 4.5,
        user_ratings_total: 42
      }));

      const searchResponse = {
        status: 'OK',
        results
      };

      global.fetch.mockResolvedValue({
        json: jest.fn().mockResolvedValue(searchResponse),
        ok: true
      });

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY', 30);

      expect(result.found).toBe(30);
    });

    test('handles pagination with next_page_token', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      let callCount = 0;
      global.fetch.mockImplementation(async () => {
        callCount++;
        const mockResponse = {
          status: 'OK',
          results: [
            {
              name: `Co ${callCount}`,
              place_id: `place${callCount}`,
              formatted_address: `${callCount} Main St`,
              rating: 4.5,
              user_ratings_total: 42
            }
          ],
          next_page_token: callCount < 2 ? 'token123' : null
        };
        return {
          json: jest.fn().mockResolvedValue(mockResponse),
          ok: true
        };
      });

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY', 50);

      expect(result.found).toBeGreaterThan(1);
    });

    test('handles API errors gracefully', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      const searchResponse = {
        status: 'REQUEST_DENIED',
        error_message: 'Invalid API key'
      };

      global.fetch.mockResolvedValue({
        json: jest.fn().mockResolvedValue(searchResponse),
        ok: false
      });

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(result.success).toBe(false);
    });

    test('handles network errors', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      global.fetch.mockRejectedValue(new Error('Network error'));

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    test('inserts prospects into database', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      const searchResponse = {
        status: 'OK',
        results: [
          {
            name: 'Sample Dental Co',
            place_id: 'place123',
            formatted_address: '123 Main St, New York, NY',
            rating: 4.5,
            user_ratings_total: 42
          }
        ],
        next_page_token: null
      };

      const detailResponse = {
        result: {
          international_phone_number: '+1-212-555-1234',
          website: 'https://example.com'
        }
      };

      global.fetch.mockImplementation(async (url) => {
        if (url.includes('textsearch')) {
          return {
            json: jest.fn().mockResolvedValue(searchResponse),
            ok: true
          };
        } else if (url.includes('details')) {
          return {
            json: jest.fn().mockResolvedValue(detailResponse),
            ok: true
          };
        }
      });

      await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      const prospect = db.prepare(
        'SELECT * FROM prospects WHERE business_name = ? AND city = ?'
      ).get('Sample Dental Co', 'New York');

      expect(prospect).toBeDefined();
      expect(prospect.phone).toBe('+1-212-555-1234');
      expect(prospect.website).toBe('https://example.com');
      expect(prospect.industry).toBe('Dentist');
      expect(prospect.state).toBe('NY');
      expect(prospect.status).toBe('new');
    });

    test('handles empty results gracefully', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      const searchResponse = {
        status: 'ZERO_RESULTS',
        results: []
      };

      global.fetch.mockResolvedValue({
        json: jest.fn().mockResolvedValue(searchResponse),
        ok: true
      });

      const result = await scrapeGoogleMaps(db, 'Invalid', 'NoWhere', 'XX');

      expect(result.success).toBe(true);
      expect(result.found).toBe(0);
      expect(result.new).toBe(0);
    });
  });
});
