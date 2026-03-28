/**
 * Email Verifier — checks if an email address can receive mail BEFORE sending.
 *
 * Three-layer check:
 * 1. Syntax validation (regex)
 * 2. MX record lookup (does the domain have a mail server?)
 * 3. SMTP handshake probe (connect to MX, RCPT TO — does the mailbox exist?)
 *
 * The SMTP probe catches 550 "user does not exist" errors BEFORE we waste a send.
 */
const dns = require('dns');
const net = require('net');

// Cache MX lookups to avoid repeat DNS queries (domain → MX host)
const mxCache = new Map();
const MX_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Cache verification results (email → { valid, checkedAt })
const verifyCache = new Map();
const VERIFY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 10000;

// Domains known to accept-all (greylisting / catch-all) — skip SMTP probe
const CATCH_ALL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'live.com', 'msn.com',
]);

/**
 * Look up MX records for a domain.
 * @param {string} domain
 * @returns {Promise<string|null>} Best MX host or null
 */
function lookupMX(domain) {
  // Check cache
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.ts < MX_CACHE_TTL) {
    return Promise.resolve(cached.host);
  }

  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        resolve(null);
        return;
      }
      // Pick lowest priority (highest preference) MX
      addresses.sort((a, b) => a.priority - b.priority);
      const host = addresses[0].exchange;
      mxCache.set(domain, { host, ts: Date.now() });

      // Prune cache
      if (mxCache.size > MAX_CACHE_SIZE) {
        const oldest = mxCache.keys().next().value;
        mxCache.delete(oldest);
      }

      resolve(host);
    });
  });
}

/**
 * SMTP probe — connect to MX server and check if RCPT TO is accepted.
 * Does NOT send any email. Just checks if the mailbox exists.
 *
 * @param {string} mxHost - MX server hostname
 * @param {string} email - Email address to verify
 * @param {number} timeoutMs - Connection timeout
 * @returns {Promise<{valid: boolean, reason: string}>}
 */
function smtpProbe(mxHost, email, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let resolved = false;
    let response = '';

    const finish = (valid, reason) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch (_) {}
      resolve({ valid, reason });
    };

    socket.setTimeout(timeoutMs);
    // Cloud hosts (Railway, Heroku, etc.) block outbound port 25.
    // Treat timeout/connection errors as inconclusive → assume valid.
    socket.on('timeout', () => finish(true, 'timeout'));
    socket.on('error', () => finish(true, 'connection_error'));

    socket.on('data', (data) => {
      response += data.toString();

      // Process complete lines
      if (!response.includes('\r\n') && !response.includes('\n')) return;

      const code = parseInt(response.substring(0, 3), 10);

      if (step === 0) {
        // Server greeting
        if (code === 220) {
          step = 1;
          response = '';
          socket.write(`EHLO verify.elyvn.com\r\n`);
        } else {
          finish(false, `greeting_${code}`);
        }
      } else if (step === 1) {
        // EHLO response
        if (code === 250) {
          step = 2;
          response = '';
          socket.write(`MAIL FROM:<verify@elyvn.com>\r\n`);
        } else {
          finish(false, `ehlo_${code}`);
        }
      } else if (step === 2) {
        // MAIL FROM response
        if (code === 250) {
          step = 3;
          response = '';
          socket.write(`RCPT TO:<${email}>\r\n`);
        } else {
          finish(false, `mailfrom_${code}`);
        }
      } else if (step === 3) {
        // RCPT TO response — this is the one that matters
        if (code === 250 || code === 251) {
          // Mailbox exists (or will forward)
          step = 4;
          socket.write(`QUIT\r\n`);
          finish(true, 'accepted');
        } else if (code === 550 || code === 551 || code === 552 || code === 553) {
          // Mailbox does not exist
          step = 4;
          socket.write(`QUIT\r\n`);
          finish(false, `rejected_${code}`);
        } else if (code === 450 || code === 451 || code === 452) {
          // Temporary failure — mailbox might exist, treat as valid to be safe
          step = 4;
          socket.write(`QUIT\r\n`);
          finish(true, `temp_${code}`);
        } else {
          step = 4;
          socket.write(`QUIT\r\n`);
          finish(false, `rcpt_${code}`);
        }
      }
    });

    socket.connect(25, mxHost);
  });
}

/**
 * Verify an email address can receive mail.
 *
 * @param {string} email
 * @returns {Promise<{valid: boolean, reason: string, method: string}>}
 */
async function verifyEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, reason: 'empty', method: 'syntax' };
  }

  const normalized = email.trim().toLowerCase();

  // Check cache
  const cached = verifyCache.get(normalized);
  if (cached && Date.now() - cached.checkedAt < VERIFY_CACHE_TTL) {
    return { valid: cached.valid, reason: cached.reason, method: 'cache' };
  }

  // 1. Syntax check
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(normalized)) {
    cacheResult(normalized, false, 'invalid_syntax');
    return { valid: false, reason: 'invalid_syntax', method: 'syntax' };
  }

  const domain = normalized.split('@')[1];

  // 2. MX record lookup
  const mxHost = await lookupMX(domain);
  if (!mxHost) {
    cacheResult(normalized, false, 'no_mx_records');
    return { valid: false, reason: 'no_mx_records', method: 'dns' };
  }

  // 3. Skip SMTP probe for catch-all domains (they accept everything)
  if (CATCH_ALL_DOMAINS.has(domain)) {
    cacheResult(normalized, true, 'catch_all_domain');
    return { valid: true, reason: 'catch_all_domain', method: 'dns' };
  }

  // 4. SMTP probe
  try {
    const result = await smtpProbe(mxHost, normalized);
    cacheResult(normalized, result.valid, result.reason);
    return { valid: result.valid, reason: result.reason, method: 'smtp' };
  } catch (err) {
    // On probe failure, assume valid to avoid false negatives
    cacheResult(normalized, true, 'probe_error');
    return { valid: true, reason: 'probe_error', method: 'smtp' };
  }
}

function cacheResult(email, valid, reason) {
  verifyCache.set(email, { valid, reason, checkedAt: Date.now() });
  if (verifyCache.size > MAX_CACHE_SIZE) {
    const oldest = verifyCache.keys().next().value;
    verifyCache.delete(oldest);
  }
}

module.exports = { verifyEmail, lookupMX };
