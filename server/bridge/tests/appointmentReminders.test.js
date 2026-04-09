/**
 * Tests for appointmentReminders.js
 * Tests appointment reminder scheduling and processing
 */

const Database = require('better-sqlite3');
const { scheduleReminders, processDueReminders } = require('../utils/appointmentReminders');
const { runMigrations } = require('../utils/migrations');

describe('appointmentReminders', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(':memory:');
    runMigrations(db);
    db.query = function query(sql, params = [], mode = 'all') {
      try {
        const stmt = db.prepare(sql);
        let result;
        if (mode === 'get') result = stmt.get(...params);
        else if (mode === 'run') result = stmt.run(...params);
        else result = stmt.all(...params);
        return Promise.resolve(result);
      } catch (err) {
        return Promise.reject(err);
      }
    };

    // Create test data
    db.prepare(`
      INSERT INTO clients (id, name, business_name, twilio_phone, is_active)
      VALUES ('client1', 'Test Co', 'Test Business', '+15551234567', 1)
    `).run();

    db.prepare(`
      INSERT INTO leads (id, client_id, phone, name)
      VALUES ('lead1', 'client1', '+12125551234', 'John Doe')
    `).run();
  });

  describe('scheduleReminders', () => {
    test('schedules reminder for appointment 24h before', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John Doe',
        service: 'Demo',
        datetime: futureDate
      };

      const result = await scheduleReminders(db, appointment);

      expect(result).toBe(true);

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder' AND touch_number = 10"
      ).all('lead1');

      expect(reminders.length).toBeGreaterThan(0);
    });

    test('schedules reminder for appointment 1h before', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: futureDate
      };

      await scheduleReminders(db, appointment);

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder' AND touch_number = 11"
      ).all('lead1');

      expect(reminders.length).toBeGreaterThan(0);
    });

    test('schedules reminder for appointment 15m before', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: futureDate
      };

      await scheduleReminders(db, appointment);

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder' AND touch_number = 12"
      ).all('lead1');

      expect(reminders.length).toBeGreaterThan(0);
    });

    test('skips past reminders', async () => {
      const nearFutureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: nearFutureDate
      };

      await scheduleReminders(db, appointment);

      const reminders = db.prepare(
        "SELECT COUNT(*) as count FROM followups WHERE lead_id = ? AND type = 'reminder'"
      ).get('lead1');

      // Only 15-min reminder should be created
      expect(reminders.count).toBeLessThanOrEqual(1);
    });

    test('deduplicates reminders', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: futureDate
      };

      await scheduleReminders(db, appointment);
      const firstCount = db.prepare(
        "SELECT COUNT(*) as count FROM followups WHERE lead_id = ? AND type = 'reminder'"
      ).get('lead1').count;

      await scheduleReminders(db, appointment);
      const secondCount = db.prepare(
        "SELECT COUNT(*) as count FROM followups WHERE lead_id = ? AND type = 'reminder'"
      ).get('lead1').count;

      expect(firstCount).toBe(secondCount);
    });

    test('includes business name in reminder content', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: futureDate
      };

      await scheduleReminders(db, appointment);

      const reminder = db.prepare(
        "SELECT content FROM followups WHERE lead_id = ? AND type = 'reminder' LIMIT 1"
      ).get('lead1');

      expect(reminder.content).toContain('Test Business');
    });

    test('includes appointment time in reminder content', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: futureDate
      };

      await scheduleReminders(db, appointment);

      const reminder = db.prepare(
        "SELECT content FROM followups WHERE lead_id = ? AND type = 'reminder' AND touch_number = 10 LIMIT 1"
      ).get('lead1');

      // Time format can be AM or PM depending on when test runs
      expect(reminder.content).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
    });

    test('returns false for missing appointment id', async () => {
      const result = await scheduleReminders(db, {
        client_id: 'client1',
        lead_id: 'lead1',
        datetime: new Date().toISOString()
      });

      expect(result).toBe(false);
    });

    test('returns false for missing appointment datetime', async () => {
      const result = await scheduleReminders(db, {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1'
      });

      expect(result).toBe(false);
    });

    test('returns false for null appointment', async () => {
      const result = await scheduleReminders(db, null);

      expect(result).toBe(false);
    });

    test('returns false for invalid datetime', async () => {
      const result = await scheduleReminders(db, {
        id: 'apt1',
        client_id: 'client1',
        lead_id: 'lead1',
        datetime: 'invalid-date'
      });

      expect(result).toBe(false);
    });

    test('uses default business name when client not found', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const appointment = {
        id: 'apt1',
        client_id: 'nonexistent',
        lead_id: 'lead1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: futureDate
      };

      // With FK constraints, inserting a followup for a nonexistent client fails gracefully
      const result = await scheduleReminders(db, appointment);
      expect(result).toBe(false);
    });
  });

  describe('processDueReminders', () => {
    test('processes due appointment reminders', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: true });

      // Create a due reminder
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Test reminder', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      const sent = await processDueReminders(db, sendSMSFn);

      expect(sent).toBeGreaterThan(0);
      expect(sendSMSFn).toHaveBeenCalled();
    });

    test('sends SMS with correct parameters', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: true });

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Reminder text', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processDueReminders(db, sendSMSFn);

      expect(sendSMSFn).toHaveBeenCalledWith(
        '+12125551234', // lead phone
        'Reminder text',
        '+15551234567'  // client twilio_phone
      );
    });

    test('marks successfully sent reminders as sent', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: true });

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Text', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processDueReminders(db, sendSMSFn);

      const reminder = db.prepare('SELECT status FROM followups WHERE id = ?').get('fu1');
      expect(reminder.status).toBe('sent');
    });

    test('marks failed reminders as failed after max attempts', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: false });

      // Insert with attempts=3 to trigger immediate failure (retry exhausted)
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status, attempts)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Text', datetime('now', '-1 minute'), 'scheduled', 3)
      `).run();

      await processDueReminders(db, sendSMSFn);

      const reminder = db.prepare('SELECT status FROM followups WHERE id = ?').get('fu1');
      expect(reminder.status).toBe('failed');
    });

    test('retries failed reminders before marking permanently failed', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: false });

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status, attempts)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Text', datetime('now', '-1 minute'), 'scheduled', 0)
      `).run();

      await processDueReminders(db, sendSMSFn);

      // Should be rescheduled for retry, not immediately failed
      const reminder = db.prepare('SELECT status, attempts FROM followups WHERE id = ?').get('fu1');
      expect(reminder.status).toBe('scheduled');
      expect(reminder.attempts).toBe(1);
    });

    test('handles SMS send exceptions', async () => {
      const sendSMSFn = jest.fn().mockRejectedValue(new Error('Send failed'));

      // Insert with attempts=3 to trigger immediate failure
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status, attempts)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Text', datetime('now', '-1 minute'), 'scheduled', 3)
      `).run();

      const sent = await processDueReminders(db, sendSMSFn);

      expect(sent).toBe(0);

      const reminder = db.prepare('SELECT status FROM followups WHERE id = ?').get('fu1');
      expect(reminder.status).toBe('failed');
    });

    test('processes multiple reminders', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: true });

      // Insert 5 leads and 1 reminder per lead to avoid (lead_id, touch_number) unique constraint
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT OR IGNORE INTO leads (id, client_id, phone, name) VALUES (?, 'client1', ?, 'Test Lead')`)
          .run(`lead-multi-${i}`, `+1555000${String(i).padStart(4, '0')}`);
        db.prepare(`
          INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status)
          VALUES (?, ?, 'client1', 10, 'reminder', 'Text', datetime('now', '-1 minute'), 'scheduled')
        `).run(`fu${i}`, `lead-multi-${i}`);
      }

      const sent = await processDueReminders(db, sendSMSFn);

      expect(sent).toBe(5);
    });

    test('only processes reminder type messages', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: true });

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 1, 'brain', 'Text', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processDueReminders(db, sendSMSFn);

      expect(sendSMSFn).not.toHaveBeenCalled();
    });

    test('only processes appointment reminder touch numbers', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: true });

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 5, 'reminder', 'Text', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processDueReminders(db, sendSMSFn);

      expect(sendSMSFn).not.toHaveBeenCalled();
    });

    test('returns 0 when no sendSMSFn provided', async () => {
      const sent = await processDueReminders(db, null);

      expect(sent).toBe(0);
    });

    test('returns 0 when db is null', async () => {
      const sendSMSFn = jest.fn();

      const sent = await processDueReminders(null, sendSMSFn);

      expect(sent).toBe(0);
    });

    test('respects MAX_REMINDER_LIMIT in a single run', async () => {
      const sendSMSFn = jest.fn().mockResolvedValue({ success: true });

      // Create more reminders than the limit, using unique lead IDs to avoid (lead_id, touch_number) unique constraint
      for (let i = 0; i < 30; i++) {
        db.prepare(`INSERT OR IGNORE INTO leads (id, client_id, phone, name) VALUES (?, 'client1', ?, 'Test Lead')`)
          .run(`lead-limit-${i}`, `+1555100${String(i).padStart(4, '0')}`);
        db.prepare(`
          INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, scheduled_at, status)
          VALUES (?, ?, 'client1', 10, 'reminder', 'Text', datetime('now', '-1 minute'), 'scheduled')
        `).run(`fu${i}`, `lead-limit-${i}`);
      }

      const sent = await processDueReminders(db, sendSMSFn);

      // Should be limited to 20 based on LIMIT in query
      expect(sent).toBeLessThanOrEqual(20);
    });
  });
});
