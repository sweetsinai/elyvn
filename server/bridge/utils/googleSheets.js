'use strict';

/**
 * Google Sheets Integration
 *
 * Writes call logs, bookings, leads, and SMS events to a client's Google Sheet
 * in real-time. Each client configures their own Sheet ID in Settings.
 *
 * Setup: Client shares their Google Sheet with elyvn-bot@elyvn-491010.iam.gserviceaccount.com
 * then pastes the Sheet ID into Settings → Google Sheet ID.
 *
 * Sheet structure (auto-created tabs):
 *   Calls    — timestamp, caller, phone, duration, outcome, score, summary
 *   Bookings — timestamp, name, phone, email, service, date/time, status
 *   Leads    — timestamp, name, phone, stage, score, source, last_contact
 *   Messages — timestamp, direction, phone, body, channel
 */

const { logger } = require('./logger');

let _sheets = null;
let _auth = null;

/**
 * Lazy-init Google Sheets API client.
 * Returns null if GOOGLE_SERVICE_ACCOUNT_JSON is not configured.
 */
function getSheetsClient() {
  if (_sheets) return _sheets;

  const creds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!creds) return null;

  try {
    const { google } = require('googleapis');
    const credentials = JSON.parse(creds);

    _auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    _sheets = google.sheets({ version: 'v4', auth: _auth });
    logger.info('[sheets] Google Sheets API initialized');
    return _sheets;
  } catch (err) {
    logger.error('[sheets] Failed to initialize:', err.message);
    return null;
  }
}

// ─── Tab names ──────────────────────────────────────────────────────────────

const TABS = {
  CALLS: 'Calls',
  BOOKINGS: 'Bookings',
  LEADS: 'Leads',
  MESSAGES: 'Messages',
};

const TAB_HEADERS = {
  [TABS.CALLS]: ['Timestamp', 'Caller Name', 'Phone', 'Duration (s)', 'Outcome', 'Score', 'Summary'],
  [TABS.BOOKINGS]: ['Timestamp', 'Name', 'Phone', 'Email', 'Service', 'Booking Date', 'Status'],
  [TABS.LEADS]: ['Timestamp', 'Name', 'Phone', 'Stage', 'Score', 'Source', 'Last Contact'],
  [TABS.MESSAGES]: ['Timestamp', 'Direction', 'Phone', 'Body', 'Channel'],
};

// ─── Ensure tab exists with headers ─────────────────────────────────────────

async function ensureTab(spreadsheetId, tabName) {
  const sheets = getSheetsClient();
  if (!sheets) return false;

  try {
    // Check if tab exists
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    const existing = meta.data.sheets.map(s => s.properties.title);

    if (!existing.includes(tabName)) {
      // Create tab
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }],
        },
      });

      // Add headers
      if (TAB_HEADERS[tabName]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tabName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [TAB_HEADERS[tabName]] },
        });
      }

      logger.info(`[sheets] Created tab "${tabName}" in ${spreadsheetId}`);
    }

    return true;
  } catch (err) {
    logger.error(`[sheets] ensureTab "${tabName}" failed:`, err.message);
    return false;
  }
}

// ─── Append a row to a tab ──────────────────────────────────────────────────

async function appendRow(spreadsheetId, tabName, row) {
  const sheets = getSheetsClient();
  if (!sheets || !spreadsheetId) return;

  try {
    await ensureTab(spreadsheetId, tabName);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    logger.debug(`[sheets] Appended row to ${tabName} in ${spreadsheetId}`);
  } catch (err) {
    logger.error(`[sheets] appendRow failed (${tabName}):`, err.message);
  }
}

// ─── Event-specific helpers ─────────────────────────────────────────────────

/**
 * Log a completed call to the Calls tab.
 */
async function logCall(spreadsheetId, call) {
  await appendRow(spreadsheetId, TABS.CALLS, [
    new Date().toISOString(),
    call.caller_name || 'Unknown',
    call.caller_phone || '',
    call.duration || 0,
    call.outcome || 'unknown',
    call.score || '',
    (call.summary || '').substring(0, 500),
  ]);
}

/**
 * Log a new booking to the Bookings tab.
 */
async function logBooking(spreadsheetId, booking) {
  await appendRow(spreadsheetId, TABS.BOOKINGS, [
    new Date().toISOString(),
    booking.name || 'Unknown',
    booking.phone || '',
    booking.email || '',
    booking.service || '',
    booking.start_time || '',
    booking.status || 'confirmed',
  ]);
}

/**
 * Log a lead creation/update to the Leads tab.
 */
async function logLead(spreadsheetId, lead) {
  await appendRow(spreadsheetId, TABS.LEADS, [
    new Date().toISOString(),
    lead.name || 'Unknown',
    lead.phone || '',
    lead.stage || 'new',
    lead.score || 0,
    lead.source || '',
    lead.last_contact || '',
  ]);
}

/**
 * Log an SMS to the Messages tab.
 */
async function logMessage(spreadsheetId, msg) {
  await appendRow(spreadsheetId, TABS.MESSAGES, [
    new Date().toISOString(),
    msg.direction || 'unknown',
    msg.phone || '',
    (msg.body || '').substring(0, 500),
    msg.channel || 'sms',
  ]);
}

/**
 * Check if Google Sheets is configured and working.
 */
function isConfigured() {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

module.exports = {
  logCall,
  logBooking,
  logLead,
  logMessage,
  appendRow,
  ensureTab,
  isConfigured,
  TABS,
};
