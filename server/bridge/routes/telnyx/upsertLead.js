/**
 * Upserts a lead record and inserts the inbound message row inside a transaction.
 * Returns { leadId, isNewLead }.
 */

const { randomUUID } = require('crypto');
const { isAsync } = require('../../utils/dbAdapter');
const { encrypt } = require('../../utils/encryption');
const { logger } = require('../../utils/logger');

async function upsertLeadAndRecordInbound(db, { clientId, from, body, messageId, confidence, inboundId }) {
  const now = new Date().toISOString();
  let leadId, isNewLead;

  if (isAsync(db)) {
    // Postgres: async transaction via manual BEGIN/COMMIT
    await db.query('BEGIN', [], 'run');
    try {
      const existingLead = await db.query(
        'SELECT id FROM leads WHERE phone = ? AND client_id = ?',
        [from, clientId], 'get'
      );

      if (existingLead) {
        leadId = existingLead.id;
        isNewLead = false;
        await db.query('UPDATE leads SET last_contact = ?, updated_at = ? WHERE id = ?',
          [now, now, leadId], 'run');
      } else {
        leadId = randomUUID();
        isNewLead = true;
        await db.query(`
          INSERT INTO leads (id, client_id, phone, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, 'new', ?, ?, ?)
        `, [leadId, clientId, from, now, now, now], 'run');
        try { await db.query('UPDATE leads SET phone_encrypted = ? WHERE id = ?', [encrypt(from), leadId], 'run'); } catch (encErr) { logger.warn('[telnyx] phone encryption failed:', encErr.message); }
      }

      await db.query(`
        INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, confidence, created_at)
        VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, ?, datetime('now'))
      `, [inboundId, clientId, leadId, from, body, messageId || null, confidence], 'run');

      await db.query('COMMIT', [], 'run');
    } catch (txErr) {
      await db.query('ROLLBACK', [], 'run');
      throw txErr;
    }
  } else {
    // SQLite: sync transaction
    const upsertAndRecord = db.transaction(() => {
      const existingLead = db.prepare(
        'SELECT id FROM leads WHERE phone = ? AND client_id = ?'
      ).get(from, clientId);

      let lid;
      if (existingLead) {
        lid = existingLead.id;
        db.prepare('UPDATE leads SET last_contact = ?, updated_at = ? WHERE id = ?')
          .run(now, now, lid);
      } else {
        lid = randomUUID();
        db.prepare(`
          INSERT INTO leads (id, client_id, phone, stage, last_contact, created_at, updated_at)
          VALUES (?, ?, ?, 'new', ?, ?, ?)
        `).run(lid, clientId, from, now, now, now);
        try { db.prepare('UPDATE leads SET phone_encrypted = ? WHERE id = ?').run(encrypt(from), lid); } catch (encErr) { logger.warn('[telnyx] phone encryption failed:', encErr.message); }
      }

      db.prepare(`
        INSERT INTO messages (id, client_id, lead_id, phone, channel, direction, body, status, message_sid, confidence, created_at)
        VALUES (?, ?, ?, ?, 'sms', 'inbound', ?, 'received', ?, ?, datetime('now'))
      `).run(inboundId, clientId, lid, from, body, messageId || null, confidence);

      return { leadId: lid, isNew: !existingLead };
    });

    const result = upsertAndRecord();
    leadId = result.leadId;
    isNewLead = result.isNew;
  }

  return { leadId, isNewLead };
}

module.exports = { upsertLeadAndRecordInbound };
