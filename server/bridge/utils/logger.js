const { logger } = require('logger');
/**
 * File-based Logger
 * Writes structured JSON logs to rotating files (production) or human-readable logs (development).
 * Keeps last 7 days of logs. Auto-creates logs/ directory.
 * Uses AsyncLocalStorage for automatic correlation ID propagation.
 */

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '../../logs');
const MAX_LOG_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SERVICE_NAME = 'elyvn-bridge';

// Log level hierarchy
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const DEFAULT_LEVEL = IS_PRODUCTION ? 'info' : 'debug';
const CONFIGURED_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] !== undefined
  ? process.env.LOG_LEVEL
  : DEFAULT_LEVEL;

// AsyncLocalStorage for correlation ID propagation
const correlationStore = new AsyncLocalStorage();

// Lazy reference to requestContext's asyncLocalStorage to avoid a circular
// dependency at load time (requestContext does not import from logger).
let _requestContextStorage = null;
function _getRequestContextStorage() {
  if (!_requestContextStorage) {
    try {
      ({ asyncLocalStorage: _requestContextStorage } = require('../middleware/requestContext'));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  }
  return _requestContextStorage;
}

/**
 * Get the current requestId from the requestContext async context, or undefined.
 */
function getRequestId() {
  const store = _getRequestContextStorage()?.getStore();
  return store?.requestId;
}

/**
 * Run a function with a correlation ID bound to the async context.
 * All logger calls within fn (including in async callbacks) will
 * automatically include the correlationId.
 */
function withCorrelationId(correlationId, fn) {
  return correlationStore.run({ correlationId }, fn);
}

/**
 * Get the current correlation ID from the async context, or undefined.
 */
function getCorrelationId() {
  const store = correlationStore.getStore();
  return store ? store.correlationId : undefined;
}

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }

let currentDate = '';
let writeStream = null;

function getStream() {
  const today = new Date().toISOString().split('T')[0];
  if (today !== currentDate || !writeStream) {
    if (writeStream) {
      try { writeStream.end(); } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
    }
    currentDate = today;
    const logFile = path.join(LOG_DIR, `elyvn-${today}.log`);
    writeStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  return writeStream;
}

// ANSI color codes for development output
const COLORS = {
  DEBUG: '\x1b[36m', // cyan
  INFO:  '\x1b[32m', // green
  WARN:  '\x1b[33m', // yellow
  ERROR: '\x1b[31m', // red
  RESET: '\x1b[0m',
};

// PII patterns to redact from all log output.
// Order matters: more-specific patterns (Stripe keys, cards) must fire before
// the broader phone pattern so their digit sequences are not phone-matched.
const PII_PATTERNS = [
  // JWT tokens (must precede email — dots in JWTs would partially match email)
  { pattern: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, replacement: '[JWT]' },
  // Payment provider keys (Stripe legacy + Dodo)
  { pattern: /sk_(live|test)_[\w]+/g, replacement: '[STRIPE_KEY]' },
  { pattern: /whsec_[\w]+/g, replacement: '[WEBHOOK_SECRET]' },
  // Anthropic API keys
  { pattern: /sk-ant-[\w-]+/g, replacement: '[ANTHROPIC_KEY]' },
  // Retell API keys
  { pattern: /key_[\w]+/g, replacement: '[RETELL_KEY]' },
  // Cal.com API keys
  { pattern: /cal_(live|test)_[\w]+/g, replacement: '[CAL_KEY]' },
  // Email addresses
  { pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g, replacement: '[EMAIL]' },
  // Credit card numbers — 16 digits in 4-group blocks (must precede phone)
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[CARD]' },
  // Phone numbers: E.164 (+14155551234) or NXX-NXX-XXXX / (NXX) NXX-XXXX.
  // Uses a word boundary after the last digit so we don't consume surrounding text.
  { pattern: /(\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, replacement: '[PHONE]' },
  // E.164 without separators: +1XXXXXXXXXX (11 digits)
  { pattern: /\+1\d{10}\b/g, replacement: '[PHONE]' },
];

/**
 * Redact PII from a value. Handles strings recursively through objects/arrays.
 * @param {*} obj - Value to redact
 * @returns {*} Redacted value
 */
function redactPII(obj) {
  if (typeof obj === 'string') {
    return PII_PATTERNS.reduce((s, { pattern, replacement }) => {
      // Reset lastIndex for global patterns before each use
      pattern.lastIndex = 0;
      return s.replace(pattern, replacement);
    }, obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(redactPII);
  }
  if (typeof obj === 'object' && obj !== null) {
    const SENSITIVE_KEYS = /^(password|password_hash|token|secret|api_key|auth_token|access_token)$/i;
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_KEYS.test(key) && typeof obj[key] === 'string') {
        obj[key] = '[REDACTED]';
      } else {
        obj[key] = redactPII(obj[key]);
      }
    }
    return obj;
  }
  return obj;
}

/**
 * Redact PII from a log message string (string-only convenience wrapper).
 * @param {string} msg - Raw message string
 * @returns {string} Redacted string
 */
function redact(msg) {
  if (typeof msg !== 'string') return msg;
  return redactPII(msg);
}

function buildMessage(args) {
  return args.map(a => {
    if (a instanceof Error) return redact(a.stack || a.message);
    if (typeof a === 'object' && a !== null) {
      try { return redact(JSON.stringify(redactPII(a))); } catch (_) { return redact(String(a)); }
    }
    return redact(String(a));
  }).join(' ');
}

/**
 * Format a log entry for file output (always JSON, one line per entry).
 */
function formatFileEntry(level, args) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toLowerCase(),
    message: buildMessage(args),
    service: SERVICE_NAME,
    pid: process.pid,
  };
  const correlationId = getCorrelationId();
  if (correlationId) {
    entry.correlationId = correlationId;
  }
  const store = _getRequestContextStorage()?.getStore();
  const requestId = store?.requestId;
  if (requestId) {
    entry.requestId = requestId;
  }
  if (store?.clientId) {
    entry.clientId = store.clientId;
  }
  return JSON.stringify(entry) + '\n';
}

/**
 * Format a log entry for console output.
 * Production: JSON (same as file). Development: human-readable with color.
 */
function formatConsoleArgs(level, args) {
  const correlationId = getCorrelationId();
  const requestCtxStore = _getRequestContextStorage()?.getStore();
  const requestId = requestCtxStore?.requestId;

  if (IS_PRODUCTION) {
    // In production, print JSON to stdout for log aggregators
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toLowerCase(),
      message: buildMessage(args),
      service: SERVICE_NAME,
      pid: process.pid,
    };
    if (correlationId) {
      entry.correlationId = correlationId;
    }
    if (requestId) {
      entry.requestId = requestId;
    }
    if (requestCtxStore?.clientId) {
      entry.clientId = requestCtxStore.clientId;
    }
    return [JSON.stringify(entry)];
  }

  // Development: colorized human-readable
  const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const color = COLORS[level] || COLORS.RESET;
  const corrSuffix = correlationId ? ` ${COLORS.DEBUG}(corr: ${correlationId})${COLORS.RESET}` : '';
  const reqSuffix = requestId ? ` ${COLORS.DEBUG}(req: ${requestId})${COLORS.RESET}` : '';
  const msg = buildMessage(args);
  return [`${timestamp} ${color}[${level}]${COLORS.RESET} ${msg}${corrSuffix}${reqSuffix}`];
}

function shouldLog(level) {
  return (LOG_LEVELS[level.toLowerCase()] || 0) >= (LOG_LEVELS[CONFIGURED_LEVEL] || 0);
}

// Override console methods to also write to file
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function setupLogger() {
  console.log = (...args) => {
    originalLog.apply(console, args);
    try {
      getStream().write(formatFileEntry('INFO', args));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  };

  console.error = (...args) => {
    originalError.apply(console, args);
    try {
      getStream().write(formatFileEntry('ERROR', args));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  };

  console.warn = (...args) => {
    originalWarn.apply(console, args);
    try {
      getStream().write(formatFileEntry('WARN', args));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  };

  // Clean up old logs on startup, then daily
  cleanOldLogs();
  setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

  logger.info('[logger] File logging enabled, writing to:', LOG_DIR);
}

function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('elyvn-') && f.endsWith('.log'));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_LOG_DAYS);

    for (const file of files) {
      const dateStr = file.replace('elyvn-', '').replace('.log', '');
      const fileDate = new Date(dateStr);
      if (!isNaN(fileDate.getTime()) && fileDate < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, file));
        originalLog(`[logger] Cleaned old log: ${file}`);
      }
    }
  } catch (err) {
    originalError('[logger] Failed to clean old logs:', err.message);
  }
}

// Graceful close
function closeLogger() {
  if (writeStream) {
    try { writeStream.end(); } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  }
}

// Logger API methods (for direct use in modules)
const logger = {
  info: (...args) => {
    if (!shouldLog('info')) return;
    originalLog.apply(console, formatConsoleArgs('INFO', args));
    try {
      getStream().write(formatFileEntry('INFO', args));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  },
  warn: (...args) => {
    if (!shouldLog('warn')) return;
    originalWarn.apply(console, formatConsoleArgs('WARN', args));
    try {
      getStream().write(formatFileEntry('WARN', args));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  },
  error: (...args) => {
    if (!shouldLog('error')) return;
    originalError.apply(console, formatConsoleArgs('ERROR', args));
    try {
      getStream().write(formatFileEntry('ERROR', args));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  },
  debug: (...args) => {
    if (!shouldLog('debug')) return;
    originalLog.apply(console, formatConsoleArgs('DEBUG', args));
    try {
      getStream().write(formatFileEntry('DEBUG', args));
    } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  },
};

module.exports = { setupLogger, closeLogger, logger, withCorrelationId, getCorrelationId, redact, redactPII };
