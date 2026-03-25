const Database = require('better-sqlite3');
const { executeActions } = require('../utils/actionExecutor');
const { runMigrations } = require('../utils/migrations');

jest.mock('../utils/sms');
jest.mock('../utils/telegram');
jest.mock('../utils/businessHours');

const { sendSMS } = require('../utils/sms');
const telegram = require('../utils/telegram');
const { shouldDelayUntilBusinessHours } = require('../utils/businessHours');

describe('actionExecutor.executeActions', () => {
  let db;
  let mockLeadMemory;

  beforeEach(() => {
    jest.clearAllMocks();

    db = new Database(':memory:');
    runMigrations(db);

    // Create test data
    db.prepare(`
      INSERT INTO clients (id, name, twilio_phone, telegram_chat_id, is_active)
      VALUES ('client1', 'Test Co', '+15551234567', '123456', 1)
    `).run();

    db.prepare(`
      INSERT INTO leads (id, client_id, phone, name, email, score, stage)
      VALUES ('lead1', 'client1', '+12125551234', 'John Doe', 'john@example.com', 5, 'warm')
    `).run();

    mockLeadMemory = {
      lead: {
        id: 'lead1',
        phone: '+12125551234',
        name: 'John Doe',
        email: 'john@example.com',
        score: 5,
        stage: 'warm',
      },
      client: {
        id: 'client1',
        name: 'Test Co',
        twilio_phone: '+15551234567',
        telegram_chat_id: '123456',
        is_active: 1,
      },
    };

    // Default mock implementations
    sendSMS.mockResolvedValue({ success: true, messageId: 'msg123' });
    telegram.sendMessage.mockResolvedValue({ ok: true });
    shouldDelayUntilBusinessHours.mockReturnValue(0); // No delay by default
  });

  afterEach(() => {
    db.close();
  });

  describe('send_sms action', () => {
    it('should call sendSMS with correct parameters', async () => {
      const actions = [{
        action: 'send_sms',
        to: '+12125551234',
        message: 'Hello there',
      }];

      await executeActions(db, actions, mockLeadMemory);

      expect(sendSMS).toHaveBeenCalledWith(
        '+12125551234',
        'Hello there',
        '+15551234567',
        db,
        'client1'
      );
    });

    it('should use lead phone if not specified', async () => {
      const actions = [{
        action: 'send_sms',
        message: 'Hello',
      }];

      await executeActions(db, actions, mockLeadMemory);

      expect(sendSMS).toHaveBeenCalledWith(
        '+12125551234',
        'Hello',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it('should return error if no phone available', async () => {
      const actions = [{
        action: 'send_sms',
        message: 'Hello',
      }];

      const memoryNoPhone = {
        ...mockLeadMemory,
        lead: { ...mockLeadMemory.lead, phone: null },
      };

      const results = await executeActions(db, actions, memoryNoPhone);

      expect(results[0].success).toBe(true);
      expect(results[0].result.sent).toBe(false);
      expect(results[0].result.reason).toBe('no phone');
    });

    it('should log message to database', async () => {
      const actions = [{
        action: 'send_sms',
        to: '+12125551234',
        message: 'Test SMS',
      }];

      await executeActions(db, actions, mockLeadMemory);

      const message = db.prepare(
        "SELECT * FROM messages WHERE phone = ? AND body = ? ORDER BY created_at DESC LIMIT 1"
      ).get('+12125551234', 'Test SMS');

      expect(message).toBeDefined();
      expect(message.direction).toBe('outbound');
      expect(message.reply_source).toBe('brain');
      expect(message.status).toBe('sent');
    });

    it('should queue SMS if outside business hours', async () => {
      shouldDelayUntilBusinessHours.mockReturnValue(3600000); // 1 hour delay

      const actions = [{
        action: 'send_sms',
        message: 'Hello',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].result.scheduled).toBe(true);
    });

    it('should notify owner via telegram', async () => {
      const actions = [{
        action: 'send_sms',
        message: 'Test SMS',
      }];

      await executeActions(db, actions, mockLeadMemory);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Brain auto-sent SMS')
      );
    });
  });

  describe('schedule_followup action', () => {
    it('should create followup in database', async () => {
      const actions = [{
        action: 'schedule_followup',
        message: 'Follow up with lead',
        delay_hours: 24,
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.scheduled_at).toBeDefined();

      const followup = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? AND content = ? ORDER BY created_at DESC LIMIT 1"
      ).get('lead1', 'Follow up with lead');

      expect(followup).toBeDefined();
      expect(followup.type).toBe('brain');
      expect(followup.status).toBe('scheduled');
    });

    it('should default to 2 hours delay', async () => {
      const actions = [{
        action: 'schedule_followup',
        message: 'Test',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      const followup = db.prepare(
        "SELECT * FROM followups WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get('lead1');

      expect(followup).toBeDefined();
      // Check scheduled_at is roughly 2 hours in future
      const now = Date.now();
      const scheduled = new Date(followup.scheduled_at).getTime();
      expect(scheduled - now).toBeGreaterThan(7000000); // ~2 hours - some tolerance
    });

    it('should return error if no lead', async () => {
      const actions = [{
        action: 'schedule_followup',
        message: 'Test',
      }];

      const memoryNoLead = {
        ...mockLeadMemory,
        lead: null,
      };

      const results = await executeActions(db, actions, memoryNoLead);

      expect(results[0].result.scheduled).toBe(false);
    });
  });

  describe('cancel_pending_followups action', () => {
    it('should cancel pending followups', async () => {
      // Create followups
      db.prepare(`
        INSERT INTO followups (id, lead_id, client_id, type, content, status, created_at)
        VALUES
          ('fu1', 'lead1', 'client1', 'sms', 'First', 'scheduled', datetime('now')),
          ('fu2', 'lead1', 'client1', 'sms', 'Second', 'scheduled', datetime('now')),
          ('fu3', 'lead1', 'client1', 'sms', 'Sent', 'sent', datetime('now'))
      `).run();

      const actions = [{
        action: 'cancel_pending_followups',
        reason: 'Lead booked',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.cancelled).toBe(2);

      const cancelled = db.prepare(
        "SELECT COUNT(*) as c FROM followups WHERE lead_id = ? AND status = 'cancelled'"
      ).get('lead1');

      expect(cancelled.c).toBe(2);
    });

    it('should return 0 if no lead', async () => {
      const actions = [{
        action: 'cancel_pending_followups',
        reason: 'Test',
      }];

      const memoryNoLead = {
        ...mockLeadMemory,
        lead: null,
      };

      const results = await executeActions(db, actions, memoryNoLead);

      expect(results[0].result.cancelled).toBe(0);
    });
  });

  describe('update_lead_stage action', () => {
    it('should update lead stage in database', async () => {
      const actions = [{
        action: 'update_lead_stage',
        stage: 'hot',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.new_stage).toBe('hot');

      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get('lead1');
      expect(lead.stage).toBe('hot');
    });

    it('should return error if no lead', async () => {
      const actions = [{
        action: 'update_lead_stage',
        stage: 'booked',
      }];

      const memoryNoLead = {
        ...mockLeadMemory,
        lead: null,
      };

      const results = await executeActions(db, actions, memoryNoLead);

      expect(results[0].result.updated).toBe(false);
    });
  });

  describe('update_lead_score action', () => {
    it('should update lead score in database', async () => {
      const actions = [{
        action: 'update_lead_score',
        score: 8,
        reason: 'Expressed strong interest',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.new_score).toBe(8);
      expect(results[0].result.reason).toBe('Expressed strong interest');

      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get('lead1');
      expect(lead.score).toBe(8);
    });

    it('should return error if no lead', async () => {
      const actions = [{
        action: 'update_lead_score',
        score: 10,
      }];

      const memoryNoLead = {
        ...mockLeadMemory,
        lead: null,
      };

      const results = await executeActions(db, actions, memoryNoLead);

      expect(results[0].result.updated).toBe(false);
    });
  });

  describe('notify_owner action', () => {
    it('should send telegram message to owner', async () => {
      const actions = [{
        action: 'notify_owner',
        message: 'Lead is interested',
        urgency: 'high',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.notified).toBe(true);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        '123456',
        expect.stringContaining('Lead is interested')
      );
    });

    it('should return error if no telegram chat id', async () => {
      const actions = [{
        action: 'notify_owner',
        message: 'Test',
      }];

      const memoryNoTelegram = {
        ...mockLeadMemory,
        client: { ...mockLeadMemory.client, telegram_chat_id: null },
      };

      const results = await executeActions(db, actions, memoryNoTelegram);

      expect(results[0].result.notified).toBe(false);
      expect(results[0].result.reason).toBe('no chat_id');
    });

    it('should include lead info in message', async () => {
      const actions = [{
        action: 'notify_owner',
        message: 'Important update',
        urgency: 'medium',
      }];

      await executeActions(db, actions, mockLeadMemory);

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('John Doe')
      );
    });
  });

  describe('log_insight action', () => {
    it('should log insight to console', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const actions = [{
        action: 'log_insight',
        insight: 'User shows buying intent',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.logged).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Brain Insight]')
      );
      const callArg = consoleSpy.mock.calls[0][0];
      expect(callArg).toContain('User shows buying intent');

      consoleSpy.mockRestore();
    });
  });

  describe('no_action action', () => {
    it('should return reason', async () => {
      const actions = [{
        action: 'no_action',
        reason: 'Lead not ready yet',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.reason).toBe('Lead not ready yet');
    });
  });

  describe('unknown action', () => {
    it('should return unknown flag', async () => {
      const actions = [{
        action: 'unknown_action',
      }];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results[0].success).toBe(true);
      expect(results[0].result.unknown).toBe(true);
    });
  });

  describe('multiple actions', () => {
    it('should execute all actions', async () => {
      const actions = [
        {
          action: 'send_sms',
          message: 'Hello',
        },
        {
          action: 'update_lead_score',
          score: 8,
        },
        {
          action: 'notify_owner',
          message: 'Updated',
          urgency: 'low',
        },
      ];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
      expect(sendSMS).toHaveBeenCalled();
      expect(telegram.sendMessage).toHaveBeenCalled();

      const lead = db.prepare('SELECT score FROM leads WHERE id = ?').get('lead1');
      expect(lead.score).toBe(8);
    });

    it('should continue on action failure', async () => {
      const actions = [
        {
          action: 'unknown_action',
        },
        {
          action: 'notify_owner',
          message: 'Continuing after error',
          urgency: 'low',
        },
      ];

      const results = await executeActions(db, actions, mockLeadMemory);

      expect(results).toHaveLength(2);
      expect(results[1].result.notified).toBe(true);
    });
  });
});
