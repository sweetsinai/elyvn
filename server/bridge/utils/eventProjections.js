/**
 * Event Projections — consume events from event_store to build materialized views
 *
 * Reads the append-only event log and projects it into useful summaries:
 * - Lead timelines (chronological history)
 * - Client activity aggregates
 * - Stage transition matrices (funnel analysis)
 */

const { logger } = require('./logger');
const { Events } = require('./eventStore');

// ─── Human-readable event labels ────────────────────────────────────────────

const EVENT_LABELS = {
  [Events.LeadCreated]: 'Created',
  [Events.LeadStageChanged]: 'Stage changed',
  [Events.LeadScored]: 'Scored',
  [Events.EmailSent]: 'Email sent',
  [Events.SMSSent]: 'SMS sent',
  [Events.AppointmentBooked]: 'Appointment booked',
  [Events.ReplyReceived]: 'Reply received',
};

function labelForEvent(eventType, eventData) {
  const base = EVENT_LABELS[eventType] || eventType;

  if (eventType === Events.LeadCreated) {
    const via = eventData?.source || eventData?.channel || 'system';
    return `Created via ${via}`;
  }

  if (eventType === Events.LeadStageChanged) {
    const from = eventData?.from || '?';
    const to = eventData?.to || '?';
    return `Stage changed: ${from} \u2192 ${to}`;
  }

  return base;
}

// ─── buildLeadTimeline ──────────────────────────────────────────────────────

/**
 * Build a chronological timeline of every event for a lead.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} leadId
 * @returns {Array<{ timestamp: string, event: string, details: object }>}
 */
async function buildLeadTimeline(db, leadId, clientId) {
  if (!db || !leadId) return [];

  try {
    const rows = await db.query(`
      SELECT event_type, event_data, created_at
      FROM event_store
      WHERE aggregate_id = ? AND aggregate_type = 'lead' AND client_id = ?
      ORDER BY created_at ASC, rowid ASC
    `, [leadId, clientId]);

    return rows.map(row => {
      let data;
      try { data = JSON.parse(row.event_data); } catch { data = row.event_data; }

      return {
        timestamp: row.created_at,
        event: labelForEvent(row.event_type, data),
        details: data,
      };
    });
  } catch (err) {
    logger.error(`[eventProjections] buildLeadTimeline failed (${leadId}):`, err.message);
    return [];
  }
}

// ─── buildClientActivity ────────────────────────────────────────────────────

/**
 * Aggregate event counts by type for a client over the last N days.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} clientId
 * @param {number} [days=30]
 * @returns {{ lead_created: number, sms_sent: number, calls_completed: number, appointments_booked: number, replies_received: number, ... }}
 */
async function buildClientActivity(db, clientId, days = 30) {
  if (!db || !clientId) return {};

  try {
    const safeDays = Math.max(1, Math.min(365, parseInt(days) || 30));

    const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db.query(`
      SELECT event_type, COUNT(*) as count
      FROM event_store
      WHERE client_id = ? AND created_at >= ?
      GROUP BY event_type
    `, [clientId, since]);

    // Map event types to friendly keys
    const KEY_MAP = {
      [Events.LeadCreated]: 'lead_created',
      [Events.SMSSent]: 'sms_sent',
      [Events.EmailSent]: 'email_sent',
      [Events.AppointmentBooked]: 'appointments_booked',
      [Events.ReplyReceived]: 'replies_received',
      [Events.LeadStageChanged]: 'stage_changes',
      [Events.LeadScored]: 'leads_scored',
    };

    const result = {
      lead_created: 0,
      sms_sent: 0,
      email_sent: 0,
      appointments_booked: 0,
      replies_received: 0,
      stage_changes: 0,
      leads_scored: 0,
    };

    for (const row of rows) {
      const key = KEY_MAP[row.event_type];
      if (key) {
        result[key] = row.count;
      }
    }

    return result;
  } catch (err) {
    logger.error(`[eventProjections] buildClientActivity failed (${clientId}):`, err.message);
    return {};
  }
}

// ─── buildStageTransitionMatrix ─────────────────────────────────────────────

/**
 * Build a matrix of stage-to-stage transitions for a client's leads.
 * Uses LeadStageChanged events that contain { from, to } in event_data.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} clientId
 * @returns {object} e.g. { 'new\u2192interested': 25, 'interested\u2192booked': 8, ... }
 */
async function buildStageTransitionMatrix(db, clientId) {
  if (!db || !clientId) return {};

  try {
    const rows = await db.query(`
      SELECT event_data
      FROM event_store
      WHERE client_id = ? AND event_type = ? AND aggregate_type = 'lead'
      ORDER BY created_at ASC
    `, [clientId, Events.LeadStageChanged]);

    const matrix = {};

    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.event_data); } catch { continue; }

      const from = data?.from;
      const to = data?.to;
      if (!from || !to) continue;

      const key = `${from}\u2192${to}`;
      matrix[key] = (matrix[key] || 0) + 1;
    }

    return matrix;
  } catch (err) {
    logger.error(`[eventProjections] buildStageTransitionMatrix failed (${clientId}):`, err.message);
    return {};
  }
}

module.exports = {
  buildLeadTimeline,
  buildClientActivity,
  buildStageTransitionMatrix,
};
