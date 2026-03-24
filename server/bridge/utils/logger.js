/**
 * File-based Logger
 * Writes logs to stdout AND rotating log files.
 * Keeps last 7 days of logs. Auto-creates logs/ directory.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '../../logs');
const MAX_LOG_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {}

let currentDate = '';
let writeStream = null;

function getStream() {
  const today = new Date().toISOString().split('T')[0];
  if (today !== currentDate || !writeStream) {
    if (writeStream) {
      try { writeStream.end(); } catch (_) {}
    }
    currentDate = today;
    const logFile = path.join(LOG_DIR, `elyvn-${today}.log`);
    writeStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  return writeStream;
}

function formatMessage(level, args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }).join(' ');
  return `${timestamp} [${level}] ${msg}\n`;
}

// Override console methods to also write to file
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function setupLogger() {
  console.log = (...args) => {
    originalLog.apply(console, args);
    try {
      getStream().write(formatMessage('INFO', args));
    } catch (_) {}
  };

  console.error = (...args) => {
    originalError.apply(console, args);
    try {
      getStream().write(formatMessage('ERROR', args));
    } catch (_) {}
  };

  console.warn = (...args) => {
    originalWarn.apply(console, args);
    try {
      getStream().write(formatMessage('WARN', args));
    } catch (_) {}
  };

  // Clean up old logs on startup
  cleanOldLogs();

  console.log('[logger] File logging enabled, writing to:', LOG_DIR);
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
    try { writeStream.end(); } catch (_) {}
  }
}

module.exports = { setupLogger, closeLogger };
