const { randomUUID } = require('crypto');
const { SCRAPER_RETRY_DELAY_MS } = require('../config/timing');
const { logger } = require('./logger');

async function scrapeGoogleMaps(db, industry, city, state, limit = 50) {
  const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!GOOGLE_MAPS_API_KEY) {
    logger.error('[Scraper] No GOOGLE_MAPS_API_KEY');
    return { success: false, error: 'No API key', found: 0, new: 0 };
  }

  const query = `${industry} in ${city}${state ? ', ' + state : ''}`.trim();
  logger.info(`[Scraper] Searching: "${query}"`);

  let results = [];
  let nextPageToken = null;

  try {
    // Paginate through results (max 3 pages = 60 results)
    for (let page = 0; page < 3 && results.length < limit; page++) {
      const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
      url.searchParams.set('query', query);
      url.searchParams.set('key', GOOGLE_MAPS_API_KEY);
      if (nextPageToken) url.searchParams.set('pagetoken', nextPageToken);

      const resp = await fetch(url.toString());
      const data = await resp.json();

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        logger.error('[Scraper] API error:', data.status, data.error_message);
        break;
      }

      results = results.concat(data.results || []);
      nextPageToken = data.next_page_token;
      if (!nextPageToken) break;

      // Google requires a short delay before using next_page_token
      await new Promise(r => setTimeout(r, SCRAPER_RETRY_DELAY_MS));
    }
  } catch (err) {
    logger.error('[Scraper] Fetch error:', err.message);
    return { success: false, error: err.message, found: 0, new: 0 };
  }

  // Trim to limit
  results = results.slice(0, limit);
  let newCount = 0;

  for (const place of results) {
    try {
      // Get details (phone, website) via Place Details API
      let phone = null;
      let website = null;

      if (place.place_id) {
        try {
          const detailUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
          detailUrl.searchParams.set('place_id', place.place_id);
          detailUrl.searchParams.set('fields', 'formatted_phone_number,international_phone_number,website');
          detailUrl.searchParams.set('key', GOOGLE_MAPS_API_KEY);

          const detailResp = await fetch(detailUrl.toString());
          const detailData = await detailResp.json();
          const detail = detailData.result || {};

          phone = detail.international_phone_number || detail.formatted_phone_number || null;
          website = detail.website || null;
        } catch (_) {}
      }

      // Try to scrape email from website
      let email = null;
      if (website) {
        try {
          const siteResp = await fetch(website, {
            signal: AbortSignal.timeout(5000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ELYVN/1.0)' }
          });
          if (siteResp.ok) {
            const html = await siteResp.text();
            const emailMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
            if (emailMatch) email = emailMatch[1];
          }
        } catch (_) {}
      }

      // Dedup by name+city
      const existing = db.prepare(
        'SELECT id FROM prospects WHERE business_name = ? AND city = ?'
      ).get(place.name, city);

      if (existing) continue;

      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO prospects (id, business_name, phone, email, website, address, industry, city, state, country, rating, review_count, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'US', ?, ?, 'new', ?, ?)
      `).run(
        randomUUID(),
        place.name,
        phone,
        email,
        website,
        place.formatted_address || '',
        industry,
        city,
        state || '',
        place.rating || null,
        place.user_ratings_total || 0,
        now,
        now
      );

      newCount++;
    } catch (err) {
      logger.error(`[Scraper] Error processing ${place.name}:`, err.message);
    }
  }

  logger.info(`[Scraper] Found ${results.length}, added ${newCount} new prospects`);
  return { success: true, found: results.length, new: newCount };
}

module.exports = { scrapeGoogleMaps };
