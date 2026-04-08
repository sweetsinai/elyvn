/**
 * Request Normalization Middleware
 * Cleans and normalizes incoming request body fields:
 *  - Phone numbers: strip whitespace/dashes, ensure + prefix
 *  - Emails: lowercase
 *  - Strings: trim
 *  - Sets req.tenantId from authenticated client context
 *
 * Passthrough only — never rejects a request.
 */

const PHONE_FIELDS = ['phone', 'from', 'to', 'from_number', 'to_number', 'owner_phone', 'transfer_phone'];
const EMAIL_FIELDS = ['email', 'owner_email', 'contact_email'];

/**
 * Normalize a phone number string: strip spaces, dashes, dots, parens.
 * Ensure + prefix if it looks like a full international number.
 */
function normalizePhoneValue(value) {
  if (typeof value !== 'string') return value;
  let cleaned = value.replace(/[\s\-\.\(\)]/g, '');
  // If it starts with a digit and is >= 10 chars, assume missing +
  if (/^\d{10,15}$/.test(cleaned)) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

function requestNormalization(req, res, next) {
  try {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      const body = req.body;

      for (const key of Object.keys(body)) {
        const val = body[key];

        // Trim all strings
        if (typeof val === 'string') {
          body[key] = val.trim();
        }

        // Normalize phone fields
        if (PHONE_FIELDS.includes(key) && typeof body[key] === 'string') {
          body[key] = normalizePhoneValue(body[key]);
        }

        // Normalize email fields
        if (EMAIL_FIELDS.includes(key) && typeof body[key] === 'string') {
          body[key] = body[key].toLowerCase();
        }
      }
    }

    // Set tenantId from authenticated client context
    if (req.clientId) {
      req.tenantId = req.clientId;
    } else if (req.client && req.client.id) {
      req.tenantId = req.client.id;
    }

    // RLS enforcement: propagate tenant ID to Postgres adapter when using async DB
    if (req.tenantId && req.app && req.app.locals && req.app.locals.db && req.app.locals.db._async) {
      try {
        const { setClientId } = require('../utils/supabaseAdapter');
        setClientId(req.tenantId);
      } catch (_) { /* supabaseAdapter not available — SQLite mode */ }
    }
  } catch (_) {
    // Normalization is best-effort — never block the request
  }

  next();
}

module.exports = { requestNormalization };
