'use strict';

/**
 * Google Sheets Integration
 *
 * Writes call logs, bookings, leads, and SMS events to a client's Google Sheet
 * in real-time. Each client configures their own Sheet ID in Settings.
 *
 * Auto-provisioned: on client signup, createClientSheet() creates a new
 * spreadsheet, shares it with the client's email, and stores the ID.
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
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file', // create + share spreadsheets
      ],
    });

    _sheets = google.sheets({ version: 'v4', auth: _auth });
    logger.info('[sheets] Google Sheets API initialized');
    return _sheets;
  } catch (err) {
    logger.error('[sheets] Failed to initialize:', err.message);
    return null;
  }
}

/**
 * Get Google Drive client (for sharing permissions).
 */
function getDriveClient() {
  getSheetsClient(); // ensure _auth is initialized
  if (!_auth) return null;
  const { google } = require('googleapis');
  return google.drive({ version: 'v3', auth: _auth });
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
 * Create a new Google Sheet for a client, set up all tabs, and share with client's email.
 *
 * @param {string} businessName - Client's business name (used in sheet title)
 * @param {string} clientEmail  - Client's email (gets Editor access)
 * @returns {Promise<{spreadsheetId: string, url: string} | null>}
 */
async function createClientSheet(businessName, clientEmail) {
  const sheets = getSheetsClient();
  const drive = getDriveClient();
  if (!sheets || !drive) {
    logger.warn('[sheets] Cannot create sheet — Google API not configured');
    return null;
  }

  try {
    // 1. Create spreadsheet with all 4 tabs
    const res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `ELYVN — ${businessName || 'Client'} Dashboard` },
        sheets: Object.values(TABS).map(title => ({
          properties: { title },
        })),
      },
    });

    const spreadsheetId = res.data.spreadsheetId;
    const url = res.data.spreadsheetUrl;

    // 2. Add headers to each tab
    const headerRequests = Object.entries(TAB_HEADERS).map(([tab, headers]) => ({
      range: `${tab}!A1`,
      values: [headers],
    }));

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: headerRequests,
      },
    });

    // 3. Share with client's email (Editor access)
    if (clientEmail) {
      await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: {
          role: 'writer',
          type: 'user',
          emailAddress: clientEmail,
        },
        sendNotificationEmail: true,
      });
    }

    logger.info(`[sheets] Created sheet for "${businessName}": ${spreadsheetId} (shared with ${clientEmail})`);
    return { spreadsheetId, url };
  } catch (err) {
    logger.error('[sheets] createClientSheet failed:', err.message);
    return null;
  }
}

/**
 * Check if Google Sheets is configured and working.
 */
function isConfigured() {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

module.exports = {
  createClientSheet,
  logCall,
  logBooking,
  logLead,
  logMessage,
  appendRow,
  ensureTab,
  isConfigured,
  TABS,
};
