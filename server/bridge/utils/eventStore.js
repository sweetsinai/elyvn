/**
 * Event Store — append-only domain event log
 *
 * Supports event sourcing patterns: every significant state change in the
 * system is recorded as an immutable event. Consumers can replay events to
 * reconstruct state or build projections.
 *
 * Table: event_store (created in migration 031)
 */

const { randomUUID } = require('crypto');
const { logger } = require('./logger');
const { AppError } = require('./AppError');

// ─── Event type constants ────────────────────────────────────────────────────

const Events = {
  LeadCreated: 'LeadCreated',
  LeadStageChanged: 'LeadStageChanged',
  LeadScored: 'LeadScored',
  BrainActionExecuted: 'BrainActionExecuted',
  EmailSent: 'EmailSent',
  SMSSent: 'SMSSent',
  AppointmentBooked: 'AppointmentBooked',
  ReplyReceived: 'ReplyReceived',
  BatchScoringCompleted: 'BatchScoringCompleted',
  FollowupScheduled: 'FollowupScheduled',
  OptOutRecorded: 'OptOutRecorded',
  BrainReasoningCaptured: 'BrainReasoningCaptured',
  CallAnswered: 'CallAnswered',
};

// ─── Core functions ──────────────────────────────────────────────────────────

/**
 * Append a domain event to the event store.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} aggregateId - ID of the entity this event belongs to (e.g. lead ID)
 * @param {string} aggregateType - 'lead' | 'campaign' | 'client' | 'message'
 * @param {string} eventType - One of the Events constants (or custom string)
 * @param {object} eventData - Event payload — will be JSON-serialised
 * @param {string|null} clientId - Client ID for tenant scoping (optional)
 * @returns {string} The newly created event ID
 */
async function appendEvent(db, aggregateId, aggregateType, eventType, eventData, clientId = null) {
  if (!db) throw new AppError('VALIDATION_ERROR', '[eventStore] db is required', 400);
  if (!aggregateId) throw new AppError('VALIDATION_ERROR', '[eventStore] aggregateId is required', 400);
  if (!aggregateType) throw new AppError('VALIDATION_ERROR', '[eventStore] aggregateType is required', 400);
  if (!eventType) throw new AppError('VALIDATION_ERROR', '[eventStore] eventType is required', 400);

  const id = randomUUID();
  const serialised = typeof eventData === 'string' ? eventData : JSON.stringify(eventData || {});

  try {
    await db.query(`
      INSERT INTO event_store (id, aggregate_id, aggregate_type, event_type, event_data, client_id, created_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `, [id, aggregateId, aggregateType, eventType, serialised, clientId || null, new Date().toISOString()], 'run');

    return id;
  } catch (err) {
    logger.error(`[eventStore] appendEvent failed (${aggregateType}/${aggregateId}/${eventType}):`, err.message);
    throw err;
  }
}

/**
 * Retrieve all events for an aggregate in chronological order.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} aggregateId
 * @param {string} aggregateType
 * @returns {Array<{ id, aggregate_id, aggregate_type, event_type, event_data, client_id, created_at, version }>}
 */
async function getEvents(db, aggregateId, aggregateType) {
  if (!db) throw new AppError('VALIDATION_ERROR', '[eventStore] db is required', 400);
  if (!aggregateId || !aggregateType) return [];

  try {
    const rows = await db.query(`
      SELECT id, aggregate_id, aggregate_type, event_type, event_data, client_id, created_at, version
      FROM event_store
      WHERE aggregate_id = ? AND aggregate_type = ?
      ORDER BY created_at ASC, rowid ASC
    `, [aggregateId, aggregateType]);

    // Deserialise event_data back to objects
    return rows.map(row => ({
      ...row,
      event_data: (() => {
        try { return JSON.parse(row.event_data); } catch { return row.event_data; }
      })(),
    }));
  } catch (err) {
    logger.error(`[eventStore] getEvents failed (${aggregateType}/${aggregateId}):`, err.message);
    return [];
  }
}

/**
 * Get recent events for a client across all aggregates (for audit/dashboard).
 *
 * @param {object} db
 * @param {string} clientId
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.aggregateType] - optional filter
 * @param {string} [opts.eventType] - optional filter
 * @returns {Array}
 */
async function getClientEvents(db, clientId, { limit = 50, aggregateType, eventType } = {}) {
  if (!db || !clientId) return [];

  try {
    let sql = `
      SELECT id, aggregate_id, aggregate_type, event_type, event_data, client_id, created_at
      FROM event_store
      WHERE client_id = ?
    `;
    const params = [clientId];

    if (aggregateType) {
      sql += ' AND aggregate_type = ?';
      params.push(aggregateType);
    }
    if (eventType) {
      sql += ' AND event_type = ?';
      params.push(eventType);
    }

    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
    params.push(limit);

    const rows = await db.query(sql, params);

    return rows.map(row => ({
      ...row,
      event_data: (() => {
        try { return JSON.parse(row.event_data); } catch { return row.event_data; }
      })(),
    }));
  } catch (err) {
    logger.error(`[eventStore] getClientEvents failed (${clientId}):`, err.message);
    return [];
  }
}

module.exports = {
  Events,
  appendEvent,
  getEvents,
  getClientEvents,
};
