'use strict';

/**
 * emailExtractor.js
 * Regex and HTML parsing for extracting email addresses from web pages.
 * SSRF-safe: all URLs are validated before fetching.
 */

const { logger } = require('./logger');

const EMAIL_REGEXES = [
  /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi,
  /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.(?:com|net|org|io|co|biz|info|us|ca|uk))\b/gi,
];

const EXCLUDE_EMAIL_PATTERN = /\.(png|jpg|jpeg|gif|svg|css|js|woff|ico)$/i;

const BLOCKED_EMAIL_FRAGMENTS = ['noreply', 'no-reply', 'example.com', 'sentry.io', 'wixpress.com'];

/**
 * Validate a URL is safe to fetch (SSRF protection).
 * Blocks localhost, private IPs, and cloud metadata endpoints.
 * @param {string} urlString
 * @returns {boolean}
 */
function isSafeURL(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
    if (hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    if (/^10\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^169\.254\./.test(hostname)) return false;
    if (hostname === '169.254.169.254') return false;
    if (hostname === 'metadata.google.internal') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the first valid email address from an HTML string.
 * @param {string} html - Raw HTML content
 * @returns {string|null} - First matching email, or null
 */
function extractEmailFromHTML(html) {
  for (const regex of EMAIL_REGEXES) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const candidate = match[1].toLowerCase();
      if (candidate.length >= 80) continue;
      if (EXCLUDE_EMAIL_PATTERN.test(candidate)) continue;
      if (BLOCKED_EMAIL_FRAGMENTS.some(frag => candidate.includes(frag))) continue;
      return candidate;
    }
  }
  return null;
}

/**
 * Fetch a single page and extract an email from its HTML.
 * Returns null if the page is unsafe, unreachable, or has no email.
 * @param {string} pageUrl
 * @returns {Promise<string|null>}
 */
async function fetchEmailFromPage(pageUrl) {
  if (!isSafeURL(pageUrl)) return null;
  try {
    const resp = await fetch(pageUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return extractEmailFromHTML(html);
  } catch (err) {
    logger.error('[emailExtractor] Fetch failed:', err.message);
    return null;
  }
}

/**
 * Attempt to find an email for a business by checking its homepage
 * plus common contact-page paths (/contact, /contact-us, /about).
 * @param {string} websiteUrl - The business website URL
 * @returns {Promise<string|null>} - First email found, or null
 */
async function extractEmailFromWebsite(websiteUrl) {
  if (!websiteUrl || !isSafeURL(websiteUrl)) {
    if (websiteUrl) logger.warn(`[emailExtractor] Blocked unsafe URL: ${websiteUrl}`);
    return null;
  }

  const baseUrl = websiteUrl.replace(/\/+$/, '');
  const pagesToCheck = [
    websiteUrl,
    `${baseUrl}/contact`,
    `${baseUrl}/contact-us`,
    `${baseUrl}/about`,
  ];

  for (const pageUrl of pagesToCheck) {
    const email = await fetchEmailFromPage(pageUrl);
    if (email) return email;
  }

  return null;
}

module.exports = { isSafeURL, extractEmailFromHTML, extractEmailFromWebsite };
