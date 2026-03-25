/**
 * Email tracking utilities for opens and clicks
 */

// Base URL for tracking pixel and click redirects
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : process.env.BASE_URL || 'http://localhost:3001';

/**
 * Generate an invisible tracking pixel that fires on email open
 * @param {string} emailId - Email ID to track
 * @returns {string} HTML img tag for tracking pixel
 */
function generateTrackingPixel(emailId) {
  return `<img src="${BASE_URL}/t/open/${emailId}" width="1" height="1" alt="" style="display:none;" />`;
}

/**
 * Wrap all links in email HTML with click tracking
 * @param {string} html - Email HTML content
 * @param {string} emailId - Email ID to track
 * @returns {string} HTML with wrapped links
 */
function wrapLinksWithTracking(html, emailId) {
  if (!html) return html;

  // Match all href="..." and href='...' patterns
  // Skip unsubscribe links (they contain "unsubscribe" or start with "mailto:")
  let result = html.replace(/href=["']([^"']+)["']/gi, (match, url) => {
    // Skip unsubscribe links and mailto: links
    if (url.toLowerCase().includes('unsubscribe') || url.toLowerCase().startsWith('mailto:')) {
      return match; // Return unchanged
    }

    // URL encode the original URL
    const encoded = encodeURIComponent(url);
    const trackingUrl = `${BASE_URL}/t/click/${emailId}?url=${encoded}`;
    return `href="${trackingUrl}"`;
  });

  return result;
}

module.exports = {
  generateTrackingPixel,
  wrapLinksWithTracking,
  BASE_URL,
};
