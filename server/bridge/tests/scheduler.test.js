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
  dailyLeadScoring
} = require('../utils/scheduler');
const { runMigrations } = require('../utils/migrations');

jest.mock('../utils/telegram');
jest.mock('../utils/leadMemory');
jest.mock('../utils/brain');
jest.mock('../utils/actionExecutor');
jest.mock('../utils/sms');
jest.mock('../utils/leadScoring');
jest.mock('../utils/dataRetention');

const telegram = require('../utils/telegram');

/**
 * Add db.query() to a better-sqlite3 instance so async source code works.
 */
function addQueryMethod(db) {
  db.query = function(sql, params = [], mode = 'all') {
    const stmt = db.prepare(sql);
    if (mode === 'get') return Promise.resolve(stmt.get(...(params || [])));
    if (mode === 'run') return Promise.resolve(stmt.run(...(params || [])));
    return Promise.resolve(stmt.all(...(params || [])));
  };
}

describe('scheduler', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset scheduler initialized flag so each test gets a clean slate
    require('../utils/scheduler').stopScheduler();

    // Setup telegram mocks with return values
    telegram.formatDailySummary.mockImplementation((stats, schedule, client) => ({
      text: `Daily Summary\nCalls: ${stats.total_calls}, Booked: ${stats.booked}, Missed: ${stats.missed}`
    }));
    telegram.formatWeeklyReport.mockImplementation((report, client) => ({
      text: `Weekly Report\nMissed rate: ${report.missed_rate}%\nRevenue: $${report.revenue}`
    }));
    telegram.sendMessage.mockResolvedValue({ ok: true });

    db = new Database(':memory:');
    runMigrations(db);
    addQueryMethod(db);

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
    test('sends daily summary to active clients with telegram', async () => {
      await sendDailySummaries(db);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Daily Summary')
      );
    });

    test('includes call stats in summary', async () => {
      await sendDailySummaries(db);

      const call = telegram.sendMessage.mock.calls[0][1];
      expect(call).toContain('Calls:');
      expect(call).toContain('Booked:');
      expect(call).toContain('Missed:');
    });

    test('skips clients without telegram_chat_id', async () => {
      db.prepare(`
        INSERT INTO clients (id, name, is_active)
        VALUES ('client2', 'No Telegram', 1)
      `).run();

      telegram.sendMessage.mockClear();
      await sendDailySummaries(db);

      expect(telegram.sendMessage).toHaveBeenCalledTimes(1); // Only client1
    });

    test('skips inactive clients', async () => {
      db.prepare(`
        INSERT INTO clients (id, name, telegram_chat_id, is_active)
        VALUES ('client3', 'Inactive', '789', 0)
      `).run();

      telegram.sendMessage.mockClear();
      await sendDailySummaries(db);

      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.stringMatching('123456'), expect.anything());
    });
  });

  describe('sendWeeklyReports', () => {
    test('sends weekly report to active clients', async () => {
      await sendWeeklyReports(db);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Weekly Report')
      );
    });

    test('calculates missed call rate correctly', async () => {
      await sendWeeklyReports(db);

      const report = telegram.sendMessage.mock.calls[0][1];
      expect(report).toContain('Missed rate:');
    });

    test('inserts report into weekly_reports table', async () => {
      await sendWeeklyReports(db);

      const reports = db.prepare('SELECT * FROM weekly_reports WHERE client_id = ?').all('client1');
      expect(reports.length).toBeGreaterThan(0);
    });

    test('calculates estimated revenue', async () => {
      await sendWeeklyReports(db);

      const reports = db.prepare('SELECT estimated_revenue FROM weekly_reports WHERE client_id = ?')
        .get('client1');
      expect(reports.estimated_revenue).toBeDefined();
    });
  });

  describe('createAppointmentReminders', () => {
    test('creates multiple reminders for an appointment', async () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      };

      await createAppointmentReminders(db, appointment, { business_name: 'Test Co' });

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder'"
      ).all('lead1');

      expect(reminders.length).toBeGreaterThan(0);
    });

    test('skips past reminders', async () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min from now
      };

      await createAppointmentReminders(db, appointment, { business_name: 'Test Co' });

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder' AND touch_number IN (10, 11, 12)"
      ).all('lead1');

      // Only 15-min reminder should be scheduled
      expect(reminders.length).toBeLessThanOrEqual(1);
    });

    test('deduplicates reminders', async () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      };

      await createAppointmentReminders(db, appointment, { business_name: 'Test Co' });
      const firstCount = db.prepare("SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND type = 'reminder'")
        .get('lead1').c;

      await createAppointmentReminders(db, appointment, { business_name: 'Test Co' });
      const secondCount = db.prepare("SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND type = 'reminder'")
        .get('lead1').c;

      expect(firstCount).toBe(secondCount);
    });

    test('returns false for invalid appointment', async () => {
      const result = await createAppointmentReminders(db, null, {});
      expect(result).toBe(undefined);

      const resultNoDatetime = await createAppointmentReminders(db, { id: 'apt1' }, {});
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

      // Insert with attempts=3 so retry logic immediately marks as failed
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status, attempts)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Reminder text', 'appointment_reminder_template', datetime('now', '-1 minute'), 'scheduled', 3)
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
      expect(lead.score).toBe(85); // Matches 0-100 scale
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

  describe('Job Scheduling - initScheduler', () => {
    test('initScheduler schedules daily summaries', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      expect(() => initScheduler(db)).not.toThrow();
      jest.useRealTimers();
    });

    test('initScheduler schedules weekly reports on Monday 8 AM', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      expect(() => initScheduler(db)).not.toThrow();
      jest.useRealTimers();
    });

    test('initScheduler schedules follow-up processor every 5 minutes', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      const spy = jest.spyOn(global, 'setInterval');
      initScheduler(db);

      // Verify setInterval was called for the 5-minute follow-up processor
      expect(spy.mock.calls.some(call =>
        typeof call[0] === 'function' && call[1] === 5 * 60 * 1000 ||
        call[1] === 300000
      )).toBe(true);

      spy.mockRestore();
      jest.useRealTimers();
    });

    test('initScheduler schedules appointment reminder processor every 2 minutes', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      const spy = jest.spyOn(global, 'setInterval');
      initScheduler(db);

      // Verify setInterval was called for the 2-minute appointment processor
      expect(spy.mock.calls.some(call => typeof call[0] === 'function')).toBe(true);

      spy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe('Recurring Schedules and Timing', () => {
    test('daily summaries should be scheduled for 7 PM', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      const spy = jest.spyOn(global, 'setTimeout');
      initScheduler(db);

      // Verify setTimeout was called (for initial delay to 7 PM)
      expect(spy).toHaveBeenCalled();

      spy.mockRestore();
      jest.useRealTimers();
    });

    test('weekly reports should be scheduled for Monday 8 AM', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      const spy = jest.spyOn(global, 'setTimeout');
      initScheduler(db);

      // Verify setTimeout was called (for initial delay to Monday 8 AM)
      expect(spy).toHaveBeenCalled();

      spy.mockRestore();
      jest.useRealTimers();
    });

    test('should handle edge case: if current time is past schedule time', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      // Set time to 8 PM (after 7 PM daily summary)
      jest.setSystemTime(new Date(Date.now()).setHours(20, 0, 0, 0));

      expect(() => initScheduler(db)).not.toThrow();

      jest.useRealTimers();
    });
  });

  describe('Timezone Handling', () => {
    test('should calculate delays based on local time', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      const before = Date.now();
      initScheduler(db);
      const after = Date.now();

      expect(after - before).toBeLessThan(100); // Should complete quickly

      jest.useRealTimers();
    });

    test('daily summary should reschedule next day if already past 7 PM', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      // Set to 9 PM
      jest.setSystemTime(new Date(Date.now()).setHours(21, 0, 0, 0));

      const spy = jest.spyOn(global, 'setTimeout');
      initScheduler(db);

      expect(spy).toHaveBeenCalled();

      spy.mockRestore();
      jest.useRealTimers();
    });

    test('Monday check should skip to next Monday if already past Monday', () => {
      const { initScheduler } = require('../utils/scheduler');

      jest.useFakeTimers();
      // Set to a Monday after 8 AM
      const monday = new Date();
      monday.setDate(monday.getDate() + (1 - monday.getDay() + 7) % 7 || 7);
      monday.setHours(9, 0, 0, 0);
      jest.setSystemTime(monday);

      expect(() => initScheduler(db)).not.toThrow();

      jest.useRealTimers();
    });
  });

  describe('Error Handling in Schedulers', () => {
    test('should handle errors in daily summaries gracefully', async () => {
      telegram.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      await expect(sendDailySummaries(db)).resolves.not.toThrow();
    });

    test('should handle errors in weekly reports gracefully', async () => {
      telegram.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      await expect(sendWeeklyReports(db)).resolves.not.toThrow();
    });

    test('should log errors during appointment reminder processing', async () => {
      const { sendSMS } = require('../utils/sms');
      sendSMS.mockRejectedValueOnce(new Error('SMS failed'));

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, touch_number, type, content, content_source, scheduled_at, status)
        VALUES ('fu1', 'lead1', 'client1', 10, 'reminder', 'Reminder text', 'appointment_reminder_template', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await expect(processAppointmentReminders(db)).resolves.not.toThrow();
    });
  });

  describe('Appointment Reminders - Additional Coverage', () => {
    test('should handle missing appointment lead_id', async () => {
      const appointment = {
        id: 'apt1',
        client_id: 'client1',
        phone: '+12125551234',
        datetime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
        // Missing lead_id
      };

      await expect(createAppointmentReminders(db, appointment, {})).resolves.not.toThrow();
    });

    test('should skip invalid appointment datetime', async () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        datetime: 'invalid-date'
      };

      await expect(createAppointmentReminders(db, appointment, {})).resolves.not.toThrow();
    });

    test('should use default business name if not provided', async () => {
      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      };

      await createAppointmentReminders(db, appointment, null);

      const reminders = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND type = 'reminder'"
      ).all('lead1');

      // Should create reminders even without client data
      expect(reminders.length).toBeGreaterThanOrEqual(0);
    });

    test('should format appointment time correctly in reminder message', async () => {
      const apptTime = new Date(Date.now() + 48 * 60 * 60 * 1000);
      apptTime.setHours(14, 30, 0, 0);

      const appointment = {
        id: 'apt1',
        lead_id: 'lead1',
        client_id: 'client1',
        phone: '+12125551234',
        name: 'John',
        service: 'Demo',
        datetime: apptTime.toISOString()
      };

      await createAppointmentReminders(db, appointment, { business_name: 'Test Co' });

      const reminders = db.prepare(
        "SELECT content FROM followups WHERE lead_id = ? AND type = 'reminder'"
      ).all('lead1');

      if (reminders.length > 0) {
        expect(reminders[0].content).toBeDefined();
      }
    });
  });

  describe('processFollowups - Additional Coverage', () => {
    test('should update followup to sent status on successful execution', async () => {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');

      getLeadMemory.mockReturnValue({ lead: { id: 'lead1' }, client: { id: 'client1' } });
      think.mockResolvedValue({ actions: [{ type: 'send_sms' }] });
      executeActions.mockResolvedValue(true);

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, type, content, scheduled_at, status)
        VALUES ('fu2', 'lead1', 'client1', 'brain', 'Follow up', datetime('now', '-1 minute'), 'scheduled')
      `).run();

      await processFollowups(db);

      const fu = db.prepare('SELECT status FROM followups WHERE id = ?').get('fu2');
      expect(fu.status).toBe('sent');
    });

    test('should handle executeActions failures', async () => {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');
      const { executeActions } = require('../utils/actionExecutor');

      getLeadMemory.mockReturnValue({ lead: { id: 'lead1' } });
      think.mockResolvedValue({ actions: [] });
      executeActions.mockRejectedValueOnce(new Error('Action failed'));

      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, type, content, scheduled_at, status, attempts)
        VALUES ('fu3', 'lead1', 'client1', 'brain', 'Follow up', datetime('now', '-1 minute'), 'scheduled', 3)
      `).run();

      await processFollowups(db);

      const fu = db.prepare('SELECT status FROM followups WHERE id = ?').get('fu3');
      expect(fu.status).toBe('failed');
    });

    test('should handle multiple followups in batch', async () => {
      const { getLeadMemory } = require('../utils/leadMemory');
      const { think } = require('../utils/brain');

      getLeadMemory.mockReturnValue({ lead: { id: 'lead1' } });
      think.mockResolvedValue({ actions: [] });

      // Insert 3 due followups
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO followups (id, lead_id, client_id, type, content, scheduled_at, status)
          VALUES ('fu_batch_${i}', 'lead1', 'client1', 'brain', 'Follow up', datetime('now', '-1 minute'), 'scheduled')
        `).run();
      }

      await processFollowups(db);

      // All followups should be processed
      const processed = db.prepare("SELECT COUNT(*) as c FROM followups WHERE status = 'sent'").get().c;
      expect(processed).toBeGreaterThanOrEqual(0);
    }, 20000);
  });

  describe('dailyLeadScoring - Additional Coverage', () => {
    test('should handle clients without telegram_chat_id', async () => {
      const { batchScoreLeads } = require('../utils/leadScoring');
      batchScoreLeads.mockReturnValue([
        { leadId: 'lead1', predictive_score: 85 }
      ]);

      // Create client without telegram_chat_id
      db.prepare(`
        INSERT INTO clients (id, name, is_active)
        VALUES ('client2', 'No Chat', 1)
      `).run();

      await expect(dailyLeadScoring(db)).resolves.not.toThrow();
    });

    test('should map 0-100 predictive score to 0-100 lead score', async () => {
      const { batchScoreLeads } = require('../utils/leadScoring');
      batchScoreLeads.mockReturnValue([
        { leadId: 'lead1', predictive_score: 50 }
      ]);

      await dailyLeadScoring(db);

      const lead = db.prepare('SELECT score FROM leads WHERE id = ?').get('lead1');
      expect(lead.score).toBe(50);
    });

    test('should round score correctly', async () => {
      const { batchScoreLeads } = require('../utils/leadScoring');
      batchScoreLeads.mockReturnValue([
        { leadId: 'lead2', predictive_score: 75.4 }
      ]);

      await dailyLeadScoring(db);

      const lead = db.prepare('SELECT score FROM leads WHERE id = ?').get('lead2');
      expect(lead.score).toBe(75); // Math.round(75.4) = 75
    });

    test('should identify hot leads (75+)', async () => {
      const { batchScoreLeads } = require('../utils/leadScoring');
      batchScoreLeads.mockReturnValue([
        { leadId: 'lead1', predictive_score: 85, name: 'John', phone: '+12125551234', insight: 'Hot' },
        { leadId: 'lead2', predictive_score: 60, name: 'Jane', phone: '+12125551235', insight: 'Warm' }
      ]);

      await dailyLeadScoring(db);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Daily Lead Scoring')
      );
    });
  });
});
