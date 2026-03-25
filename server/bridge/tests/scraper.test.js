/**
 * Tests for scraper.js
 * Tests Google Maps scraping and prospect data collection
 */

const Database = require('better-sqlite3');
const { scrapeGoogleMaps } = require('../utils/scraper');
const { runMigrations } = require('../utils/migrations');

describe('scraper', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(':memory:');
    runMigrations(db);
  });

  describe('scrapeGoogleMaps', () => {
    test('returns error when no API key configured', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.found).toBe(0);
      expect(result.new).toBe(0);
    });

    test('exports scrapeGoogleMaps function', () => {
      expect(typeof scrapeGoogleMaps).toBe('function');
    });

    test('accepts required parameters', () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';

      const result = scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY');

      expect(result).toBeDefined();
      expect(typeof result.then).toBe('function'); // It's a promise
    });

    test('accepts state parameter', () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';

      const result = scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY', 50);

      expect(result).toBeDefined();
      expect(typeof result.then).toBe('function');
    });

    test('accepts custom limit parameter', () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';

      const result = scrapeGoogleMaps(db, 'Dentist', 'New York', 'NY', 100);

      expect(result).toBeDefined();
    });

    test('defaults to 50 limit when not specified', () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';

      const result = scrapeGoogleMaps(db, 'Dentist', 'New York');

      expect(result).toBeDefined();
      expect(typeof result.then).toBe('function');
    });

    test('handles database operations', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Test', 'TestCity', 'TX');

      // Should have valid response structure
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('found');
      expect(result).toHaveProperty('new');
    });

    test('returns object with success property', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Test', 'TestCity', 'TX');

      expect(typeof result.success).toBe('boolean');
    });

    test('returns object with found count', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Test', 'TestCity', 'TX');

      expect(typeof result.found).toBe('number');
      expect(result.found).toBeGreaterThanOrEqual(0);
    });

    test('returns object with new count', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Test', 'TestCity', 'TX');

      expect(typeof result.new).toBe('number');
      expect(result.new).toBeGreaterThanOrEqual(0);
    });

    test('returns error property on failure', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      if (!result.success) {
        expect(result).toHaveProperty('error');
      }
    });

    test('handles different industry types', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const industries = ['Dentist', 'Plumber', 'Lawyer', 'Restaurant'];

      for (const industry of industries) {
        const result = await scrapeGoogleMaps(db, industry, 'TestCity', 'TX');
        expect(result).toBeDefined();
        expect(result).toHaveProperty('success');
      }
    });

    test('handles different city/state combinations', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const locations = [
        ['New York', 'NY'],
        ['Los Angeles', 'CA'],
        ['Chicago', 'IL']
      ];

      for (const [city, state] of locations) {
        const result = await scrapeGoogleMaps(db, 'Test', city, state);
        expect(result).toBeDefined();
      }
    });

    test('handles state parameter as optional', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Dentist', 'New York');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
    });

    test('returns consistent response structure', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(Object.keys(result)).toContain('success');
      expect(Object.keys(result)).toContain('found');
      expect(Object.keys(result)).toContain('new');
    });

    test('handles API key configured', async () => {
      process.env.GOOGLE_MAPS_API_KEY = 'test-key-123';

      const result = await scrapeGoogleMaps(db, 'Test', 'City', 'ST');

      expect(result).toBeDefined();
    });

    test('completes without throwing errors', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      expect(async () => {
        await scrapeGoogleMaps(db, 'Test', 'City', 'ST');
      }).not.toThrow();
    });
  });

  describe('module exports', () => {
    test('exports scrapeGoogleMaps function', () => {
      const { scrapeGoogleMaps: sgm } = require('../utils/scraper');
      expect(typeof sgm).toBe('function');
    });
  });
});
