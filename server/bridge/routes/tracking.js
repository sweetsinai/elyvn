const express = require('express');
const { randomUUID } = require('crypto');
const { isValidUUID } = require('../utils/validators');
const { logger } = require('../utils/logger');

const router = express.Router();

// SSRF protection utility for redirect URLs
function isSafeRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname;
    // Block internal IPs
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return false;
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) return false;
    if (hostname === '169.254.169.254') return false; // AWS metadata
    return true;
  } catch { return false; }
}

// Email open tracking pixel
router.get('/open/:emailId', async (req, res) => {
  const { emailId } = req.params;
  const db = req.app.locals.db;

  // Validate emailId format (UUID)
  if (!isValidUUID(emailId)) {
    // Return pixel anyway (don't expose invalid ID)
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    return res.send(pixel);
  }

  try {
    if (db) {
      await db.query(
        "UPDATE emails_sent SET opened_at = COALESCE(opened_at, ?), open_count = COALESCE(open_count, 0) + 1, updated_at = ? WHERE id = ?",
        [new Date().toISOString(), new Date().toISOString(), emailId],
        'run'
      );
    }
    // Emit analytics stream event (fire-and-forget)
    try {
      const { emitAnalyticsEvent } = require('../utils/analyticsStream');
      // Look up clientId from the email record
      const emailRow = await db.query(
        `SELECT es.id, c.client_id FROM emails_sent es
         JOIN campaigns c ON c.id = es.campaign_id
         WHERE es.id = ? LIMIT 1`,
        [emailId],
        'get'
      );
      if (emailRow) {
        emitAnalyticsEvent({
          type: 'email_opened',
          data: { emailId },
          clientId: emailRow.client_id,
        });
      }
    } catch (_) { /* non-fatal */ }
  } catch (err) {
    logger.error('[server] Email open tracking failed:', err.message);
  }
  // Return 1x1 transparent GIF
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(pixel);
});

// Email click tracking redirect
router.get('/click/:emailId', async (req, res) => {
  const { emailId } = req.params;
  let url = req.query.url;
  const db = req.app.locals.db;

  // Validate emailId format (UUID)
  if (!isValidUUID(emailId)) {
    return res.redirect('/');
  }

  // Generate a short session token to correlate this click with a subsequent reply
  const clickSessionId = randomUUID();

  try {
    if (db) {
      await db.query(
        "UPDATE emails_sent SET clicked_at = COALESCE(clicked_at, ?), click_count = COALESCE(click_count, 0) + 1, click_session_id = COALESCE(click_session_id, ?), updated_at = ? WHERE id = ?",
        [new Date().toISOString(), clickSessionId, new Date().toISOString(), emailId],
        'run'
      );
    }
  } catch (err) {
    logger.error('[server] Email click tracking failed:', err.message);
  }

  if (url) {
    try {
      const decodedUrl = decodeURIComponent(url);

      // URL validation: block dangerous protocols
      if (!decodedUrl || (!decodedUrl.startsWith('https://') && !decodedUrl.startsWith('http://'))) {
        return res.status(400).send('Invalid redirect URL');
      }
      // Block dangerous protocols
      if (decodedUrl.match(/^(javascript|data|vbscript):/i)) {
        return res.status(400).send('Invalid redirect URL');
      }

      // SSRF protection: validate redirect URL is safe
      if (!isSafeRedirectUrl(decodedUrl)) {
        return res.status(400).send('Invalid redirect URL');
      }

      // For absolute URLs, do validation via URL constructor
      const destUrl = new URL(decodedUrl); // Throws if invalid
      // Attach click session token so landing pages can pass it back in replies
      destUrl.searchParams.set('_csid', clickSessionId);
      return res.redirect(destUrl.toString());
    } catch (err) {
      // Invalid URL format or constructor error, redirect to home
    }
  }
  res.redirect('/');
});

module.exports = router;
