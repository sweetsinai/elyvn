/**
 * Tests for emailSender.js
 * Tests cold email sending with bounce detection and rate limiting
 */

const Database = require('better-sqlite3');
const { sendColdEmail, DAILY_LIMIT } = require('../utils/emailSender');
const { runMigrations } = require('../utils/migrations');

jest.mock('nodemailer');

describe('emailSender', () => {
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(':memory:');
    runMigrations(db);

    // Set up environment
    process.env.SMTP_USER = 'sender@example.com';
    process.env.SMTP_PASS = 'test-password';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_FROM_NAME = 'Test App';
  });

  describe('sendColdEmail', () => {
    test('sends email when SMTP is configured', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockResolvedValue({
          messageId: 'msg-123'
        })
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      const prospect = {
        id: 'p1',
        email: 'prospect@example.com',
        business_name: 'ABC Corp'
      };

      const result = await sendColdEmail(db, prospect, 'Test Subject', 'Test body');

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-123');
      expect(mockTransport.sendMail).toHaveBeenCalled();
    });

    test('returns error when SMTP not configured', async () => {
      process.env.SMTP_USER = '';

      const prospect = {
        id: 'p1',
        email: 'test@example.com'
      };

      const result = await sendColdEmail(db, prospect, 'Subject', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('returns error when prospect has no email', async () => {
      const nodemailer = require('nodemailer');
      nodemailer.createTransport.mockReturnValue({
        sendMail: jest.fn()
      });

      const prospect = {
        id: 'p1',
        business_name: 'ABC Corp'
      };

      const result = await sendColdEmail(db, prospect, 'Subject', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No email');
    });

    test('respects daily email limit', async () => {
      const nodemailer = require('nodemailer');
      nodemailer.createTransport.mockReturnValue({
        sendMail: jest.fn()
      });

      // Fill up the daily limit
      for (let i = 0; i < DAILY_LIMIT; i++) {
        db.prepare(`
          INSERT INTO emails_sent (id, prospect_id, to_email, from_email, subject, body, status, sent_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'sent', datetime('now'), datetime('now'), datetime('now'))
        `).run(`id${i}`, `p${i}`, `email${i}@example.com`, 'sender@example.com', 'Subj', 'Body');
      }

      const prospect = {
        id: 'p-new',
        email: 'new@example.com'
      };

      const result = await sendColdEmail(db, prospect, 'Subject', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Daily limit reached');
    });

    test('logs successful send to emails_sent table', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockResolvedValue({
          messageId: 'msg-123'
        })
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      const prospect = {
        id: 'p1',
        email: 'prospect@example.com',
        business_name: 'ABC Corp'
      };

      await sendColdEmail(db, prospect, 'Test Subject', 'Test body');

      const record = db.prepare('SELECT * FROM emails_sent WHERE prospect_id = ?').get('p1');
      expect(record).toBeDefined();
      expect(record.to_email).toBe('prospect@example.com');
      expect(record.status).toBe('sent');
    });

    test('updates prospect status to emailed', async () => {
      const nodemailer = require('nodemailer');
      nodemailer.createTransport.mockReturnValue({
        sendMail: jest.fn().mockResolvedValue({ messageId: 'msg-123' })
      });

      db.prepare(`
        INSERT INTO prospects (id, business_name, email, status, created_at, updated_at)
        VALUES ('p1', 'ABC Corp', 'test@example.com', 'new', datetime('now'), datetime('now'))
      `).run();

      const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get('p1');

      await sendColdEmail(db, prospect, 'Subject', 'Body');

      const updated = db.prepare('SELECT status FROM prospects WHERE id = ?').get('p1');
      expect(updated.status).toBe('emailed');
    });

    test('includes unsubscribe headers in email', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockResolvedValue({ messageId: 'msg-123' })
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      const prospect = {
        id: 'p1',
        email: 'test@example.com'
      };

      await sendColdEmail(db, prospect, 'Subject', 'Body');

      const call = mockTransport.sendMail.mock.calls[0][0];
      expect(call.headers['List-Unsubscribe']).toBeDefined();
      expect(call.headers['List-Unsubscribe-Post']).toBeDefined();
    });

    test('detects bounce errors and marks prospect as bounced', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockRejectedValue({
          responseCode: 550,
          message: 'User does not exist'
        })
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      db.prepare(`
        INSERT INTO prospects (id, business_name, email, status, created_at, updated_at)
        VALUES ('p1', 'ABC Corp', 'invalid@example.com', 'new', datetime('now'), datetime('now'))
      `).run();

      const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get('p1');

      const result = await sendColdEmail(db, prospect, 'Subject', 'Body');

      expect(result.success).toBe(false);
      expect(result.bounced).toBe(true);

      const updated = db.prepare('SELECT status FROM prospects WHERE id = ?').get('p1');
      expect(updated.status).toBe('bounced');
    });

    test('logs failed send with error to emails_sent table', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockRejectedValue(new Error('Connection timeout'))
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      const prospect = {
        id: 'p1',
        email: 'test@example.com'
      };

      await sendColdEmail(db, prospect, 'Subject', 'Body');

      const record = db.prepare('SELECT * FROM emails_sent WHERE prospect_id = ?').get('p1');
      expect(record.status).toBe('failed');
      expect(record.error).toContain('timeout');
    });

    test('uses SMTP_FROM_NAME in from field', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockResolvedValue({ messageId: 'msg-123' })
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      process.env.SMTP_FROM_NAME = 'Custom Sender Name';

      const prospect = {
        id: 'p1',
        email: 'test@example.com'
      };

      await sendColdEmail(db, prospect, 'Subject', 'Body');

      const call = mockTransport.sendMail.mock.calls[0][0];
      expect(call.from).toContain('Custom Sender Name');
    });

    test('uses default from name when not specified', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockResolvedValue({ messageId: 'msg-123' })
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      delete process.env.SMTP_FROM_NAME;

      const prospect = {
        id: 'p1',
        email: 'test@example.com'
      };

      await sendColdEmail(db, prospect, 'Subject', 'Body');

      const call = mockTransport.sendMail.mock.calls[0][0];
      expect(call.from).toContain('ELYVN');
    });

    test('creates transport with correct SMTP settings', async () => {
      const nodemailer = require('nodemailer');
      const mockTransport = {
        sendMail: jest.fn().mockResolvedValue({ messageId: 'msg-123' })
      };
      nodemailer.createTransport.mockReturnValue(mockTransport);

      const prospect = {
        id: 'p1',
        email: 'test@example.com'
      };

      await sendColdEmail(db, prospect, 'Subject', 'Body');

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 465,
          secure: true,
          auth: {
            user: 'sender@example.com',
            pass: 'test-password'
          }
        })
      );
    });

    test('detects multiple types of bounce errors', async () => {
      const nodemailer = require('nodemailer');

      const bouncePatterns = [
        { responseCode: 550, message: 'User does not exist' },
        { responseCode: 551, message: 'User not local' },
        { responseCode: 552, message: 'Quota exceeded' },
        { message: 'Email address rejected' },
        { message: 'Address is invalid' }
      ];

      for (const errorObj of bouncePatterns) {
        const mockTransport = {
          sendMail: jest.fn().mockRejectedValue(errorObj)
        };
        nodemailer.createTransport.mockReturnValue(mockTransport);

        db.prepare(`
          INSERT INTO prospects (id, business_name, email, status, created_at, updated_at)
          VALUES (?, 'Test', 'test@example.com', 'new', datetime('now'), datetime('now'))
        `).run(Math.random().toString());

        const prospect = {
          id: Math.random().toString(),
          email: 'test@example.com'
        };

        const result = await sendColdEmail(db, prospect, 'Subject', 'Body');

        // All these should be detected as bounces
        expect(result.bounced).toBe(true);
      }
    });
  });

  describe('DAILY_LIMIT constant', () => {
    test('exports DAILY_LIMIT constant', () => {
      expect(DAILY_LIMIT).toBeDefined();
      expect(typeof DAILY_LIMIT).toBe('number');
      expect(DAILY_LIMIT).toBeGreaterThan(0);
    });

    test('respects EMAIL_DAILY_LIMIT environment variable', () => {
      process.env.EMAIL_DAILY_LIMIT = '500';
      jest.resetModules();

      const { DAILY_LIMIT: newLimit } = require('../utils/emailSender');
      expect(newLimit).toBe(500);
    });
  });
});
