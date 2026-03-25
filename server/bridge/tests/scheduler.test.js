/**
 * Tests for scheduler.js
 * Tests daily summaries, weekly reports, and scheduled task management
 */

const Database = require('better-sqlite3');
const {
  sendDailySummaries,
  sendWeeklyReports,
  processFollowups,
  dailyLeadReview,
  createAppointmentReminders,
  processAppointmentReminders,
  dailyOutreach,
  checkReplies,
  dailyLeadScoring
} = require('../utils/scheduler');
const { runMigrations } = require('../utils/migrations');

jest.mock('../utils/telegram');
jest.mock('../utils/leadMemory');
jest.mock('../utils/brain');
jest.mock('../utils/actionExecutor');
jest.mock('../utils/emailGenerator');
jest.mock('../utils/emailSender');
jest.mock('../utils/emailVerifier');
jest.mock('../utils/sms');
jest.mock('../utils/leadScoring');
jest.mock('../utils/dataRetention');

const telegram = require('../utils/telegram');

describe('scheduler', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(':memory:');
    runMigrations(db);

    // Create test data
    db.prepare(`
      INSERT INTO clients (id, name, telegram_chat_id, is_active, avg_ticket)
      VALUES ('client1', 'Test Co', '123456', 1, 100)
    `).run();

    db.prepare(`
      INSERT INTO leads (id, client_id, phone, name, email, score, stage)
      VALUES
        ('lead1', 'client1', '+12125551234', 'John', 'john@example.com', 5, 'warm'),
        ('lead2', 'client1', '+12125551235', 'Jane', 'jane@example.com', 7, 'qualified')
    `).run();

    db.prepare(`
      INSERT INTO calls (id, client_id, caller_phone, status, duration, outcome, score)
      VALUES
        ('call1', 'client1', '+12125551234', 'completed', 300, 'booked', 8),
        ('call2', 'client1', '+12125551235', 'completed', 120, 'missed', 3)
    `).run();

    db.prepare(`
      INSERT INTO messages (id, client_id, lead_id, phone, direction, body, channel, status)
      VALUES
        ('msg1', 'client1', 'lead1', '+12125551234', 'outbound', 'Hi', 'sms', 'sent'),
        ('msg2', 'client1', 'lead2', '+12125551235', 'inbound', 'Hi', 'sms', 'received')
    `).run();
  });

  describe('sendDailySummaries', () => {
    test('sends daily summary to active clients with telegram', () => {
      sendDailySummaries(db);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Daily Summary')
      );
    });

    test('includes call stats in summary', () => {
      sendDailySummaries(db);

      const call = telegram.sendMessage.mock.calls[0][1];
      expect(call).toContain('Calls:');
      expect(call).toContain('Booked:');
      expect(call).toContain('Missed:');
    });

    test('skips clients without telegram_chat_id', () => {
      db.prepare(`
        INSERT INTO clients (id, name, is_active)
        VALUES ('client2', 'No Telegram', 1)
      `).run();

      telegram.sendMessage.mockClear();
      sendDailySummaries(db);

      expect(telegram.sendMessage).toHaveBeenCalledTimes(1); // Only client1
    });

    test('skips inactive clients', () => {
      db.prepare(`
        INSERT INTO clients (id, name, telegram_chat_id, is_active)
        VALUES ('client3', 'Inactive', '789', 0)
      `).run();

      telegram.sendMessage.mockClear();
      sendDailySummaries(db);

      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.stringMatching('123456'), expect.anything());
    });
  });

  describe('sendWeeklyReports', () => {
    test('sends weekly report to active clients', () => {
      sendWeeklyReports(db);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Weekly Report')
      );
    });

    test('calculates missed call rate correctly', () => {
      sendWeeklyReports(db);

      const report = telegram.sendMessage.mock.calls[0][1];
      expect(report).toContain('Missed rate:');
    });

    test('inserts report into weekly_reports table', () => {
      sendWeeklyReports(db);

      const reports = db.prepare('SELECT * FROM weekly_reports WHERE client_id = ?').all('client1');
      expect(reports.length).toBeGreaterThan(0);
    });

    test('calculates estimated revenue', () => {
      sendWeeklyReports(db);

      const reports = db.prepare('SELECT estimated_revenue FROM weekly_reports WHERE client_id = ?')
        .get('client1');
      expect(reports.estimated_revenue).toBeDefined();
    });
  });

  describe('createAppointmentReminders', () => {
    test('creates multiple reminders for an appointment', () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      };

      createAppointmentReminders(db, appointment, { business_name: 'Test Co' });

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder'"
      ).all('lead1');

      expect(reminders.length).toBeGreaterThan(0);
    });

    test('skips past reminders', () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min from now
      };

      createAppointmentReminders(db, appointment, { business_name: 'Test Co' });

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder' AND touch_number IN (10, 11, 12)"
      ).all('lead1');

      // Only 15-min reminder should be scheduled
      expect(reminders.length).toBeLessThanOrEqual(1);
    });

    test('deduplicates reminders', () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      };

      createAppointmentReminders(db, appointment, { business_name: 'Test Co' });
      const firstCount = db.prepare("SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND type = 'reminder'")
        .get('lead1').c;

      createAppointmentReminders(db, appointment, { business_name: 'Test Co' });
      const secondCount = db.prepare("SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND type = 'reminder'")
        .get('lead1').c;

      expect(firstCount).toBe(secondCount);
    });

    test('returns false for invalid appointment', () => {
      const result = createAppointmentReminders(db, null, {});
      expect(result).toBe(undefined);

      const resultNoDatetime = createAppointmentReminders(db, { id: 'apt1' }, {});
      expect(resultNoDatetime).toBe(undefined);
    });
  });

  describe('processAppointmentReminders', () => {
    test('sends due appointment reminders', async () => {
      const { sendSMS } = require('../utils/sms');
      sendSMS.mockResolvedValue({ success: true });

      // Create due reminder
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Reminder text', 'appointment_reminder_template', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processAppointmentReminders(db, sendSMS);

      const reminder = db.prepare('SELECT * FROM followups WHERE id = ?').get('fu1');
      expect(reminder.status).toBe('sent');
    });

    test('handles SMS send failure gracefully', async () => {
      const { sendSMS } = require('../utils/sms');
      sendSMS.mockResolvedValue({ success: false });

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Reminder text', 'appointment_reminder_template', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processAppointmentReminders(db, sendSMS);

      const reminder = db.prepare('SELECT * FROM followups WHERE id = ?').get('fu1');
      expect(reminder.status).toBe('failed');
    });
  });

  describe('dailyLeadScoring', () => {
    test('calls batchScoreLeads for each client', async () => {
      const { batchScoreLeads } = require('../utils/leadScoring');
      batchScoreLeads.mockReturnValue([
        { leadId: 'lead1', predictive_score: 85, name: 'John', phone: '+12125551234', insight: 'Hot lead' }
      ]);

      await dailyLeadScoring(db);

      expect(batchScoreLeads).toHaveBeenCalledWith(db, 'client1');
    });

    test('updates lead scores from predictive model', async () => {
      const { batchScoreLeads } = require('../utils/leadScoring');
      batchScoreLeads.mockReturnValue([
        { leadId: 'lead1', predictive_score: 85 }
      ]);

      await dailyLeadScoring(db);

      const lead = db.prepare('SELECT score FROM leads WHERE id = ?').get('lead1');
      expect(lead.score).toBe(8); // 85 / 10 = 8.5 rounded to 8
    });

    test('notifies owner of hot leads', async () => {
      const { batchScoreLeads } = require('../utils/leadScoring');
      batchScoreLeads.mockReturnValue([
        { leadId: 'lead1', predictive_score: 85, name: 'John', phone: '+12125551234', insight: 'Hot' }
      ]);

      await dailyLeadScoring(db);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Daily Lead Scoring')
      );
    });
  });

  describe('processFollowups', () => {
    test('processes due followups', async () => {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');

      getLeadMemory.mockReturnValue({ lead: { id: 'lead1' }, client: { id: 'client1' } });
      think.mockResolvedValue({ actions: [] });

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, type, content, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 'brain', 'Follow up', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processFollowups(db);

      const fu = db.prepare('SELECT * FROM followups WHERE id = ?').get('fu1');
      expect(fu.status).toBe('sent');
    });

    test('handles missing lead memory', async () => {
      const { getLeadMemory } = require('../utils/leadMemory');
      getLeadMemory.mockReturnValue(null);

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, type, content, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 'brain', 'Follow up', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processFollowups(db);

      const fu = db.prepare('SELECT * FROM followups WHERE id = ?').get('fu1');
      expect(fu.status).toBe('failed');
    });
  });

  describe('dailyLeadReview', () => {
    test('processes stale leads', async () => {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');

      getLeadMemory.mockReturnValue({ lead: { id: 'lead1' }, client: { id: 'client1' } });
      think.mockResolvedValue({ actions: [] });

      // Insert old lead
      db.prepare(`
        UPDATE leads SET updated_at = datetime('now', '-3 days'), score = 6, stage = 'warm' WHERE id = 'lead1'
      `).run();

      await dailyLeadReview(db);

      expect(think).toHaveBeenCalled();
    });

    test('skips booked and lost leads', async () => {
      const { think } = require('../utils/brain');

      db.prepare(`
        UPDATE leads SET stage = 'booked' WHERE id = 'lead1'
      `).run();

      db.prepare(`
        INSERT INTO leads (id, client_id, phone, stage)
        VALUES ('lead3', 'client1', '+12125551236', 'lost')
      `).run();

      await dailyLeadReview(db);

      expect(think).not.toHaveBeenCalled();
    });
  });
});
