/**
 * Tests for config.js
 * Tests configuration management, API key validation, and environment variable handling
 */

describe('config.js', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  describe('isFullyConfigured', () => {
    test('should return true when all critical APIs are configured', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key-1';
      process.env.GOOGLE_MAPS_API_KEY = 'test-key-2';
      process.env.RETELL_API_KEY = 'test-key-3';
      process.env.TELNYX_API_KEY = 'test-key-4';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-123';

      const config = require('../utils/config');
      expect(config.isFullyConfigured()).toBe(true);
    });

    test('should return false when ANTHROPIC_API_KEY is missing', () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';
      process.env.RETELL_API_KEY = 'test-key';
      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-123';

      const config = require('../utils/config');
      expect(config.isFullyConfigured()).toBe(false);
    });

    test('should return false when GOOGLE_MAPS_API_KEY is missing', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      delete process.env.GOOGLE_MAPS_API_KEY;
      process.env.RETELL_API_KEY = 'test-key';
      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-123';

      const config = require('../utils/config');
      expect(config.isFullyConfigured()).toBe(false);
    });

    test('should return false when RETELL_API_KEY is missing', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';
      delete process.env.RETELL_API_KEY;
      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-123';

      const config = require('../utils/config');
      expect(config.isFullyConfigured()).toBe(false);
    });

    test('should return false when TELNYX_API_KEY is missing', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';
      process.env.RETELL_API_KEY = 'test-key';
      delete process.env.TELNYX_API_KEY;
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-123';

      const config = require('../utils/config');
      expect(config.isFullyConfigured()).toBe(false);
    });

    test('should return false when TELNYX_PHONE_NUMBER is missing', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';
      process.env.RETELL_API_KEY = 'test-key';
      process.env.TELNYX_API_KEY = 'test-key';
      delete process.env.TELNYX_PHONE_NUMBER;
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-123';

      const config = require('../utils/config');
      expect(config.isFullyConfigured()).toBe(false);
    });

    test('should return false when TELNYX_MESSAGING_PROFILE_ID is missing', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.GOOGLE_MAPS_API_KEY = 'test-key';
      process.env.RETELL_API_KEY = 'test-key';
      process.env.TELNYX_API_KEY = 'test-key';
      process.env.TELNYX_PHONE_NUMBER = '+1234567890';
      delete process.env.TELNYX_MESSAGING_PROFILE_ID;

      const config = require('../utils/config');
      expect(config.isFullyConfigured()).toBe(false);
    });
  });

  describe('getTelnyxConfig', () => {
    test('should return Telnyx API key from config', () => {
      process.env.TELNYX_API_KEY = 'telnyx-key-test';

      const config = require('../utils/config');
      expect(config.apis.telnyxKey).toBe('telnyx-key-test');
    });

    test('should return Telnyx phone number from config', () => {
      process.env.TELNYX_PHONE_NUMBER = '+1555123456';

      const config = require('../utils/config');
      expect(config.apis.telnyxPhoneNumber).toBe('+1555123456');
    });

    test('should return Telnyx messaging profile ID from config', () => {
      process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-abc123';

      const config = require('../utils/config');
      expect(config.apis.telnyxMessagingProfileId).toBe('profile-abc123');
    });

    test('should return undefined for missing Telnyx keys', () => {
      delete process.env.TELNYX_API_KEY;
      delete process.env.TELNYX_PHONE_NUMBER;
      delete process.env.TELNYX_MESSAGING_PROFILE_ID;

      const config = require('../utils/config');
      expect(config.apis.telnyxKey).toBeUndefined();
      expect(config.apis.telnyxPhoneNumber).toBeUndefined();
      expect(config.apis.telnyxMessagingProfileId).toBeUndefined();
    });
  });

  describe('SMTP Configuration', () => {
    test('should load SMTP host from environment', () => {
      process.env.SMTP_HOST = 'smtp.example.com';

      const config = require('../utils/config');
      expect(config.smtp.host).toBe('smtp.example.com');
    });

    test('should parse SMTP port as integer', () => {
      process.env.SMTP_PORT = '587';

      const config = require('../utils/config');
      expect(config.smtp.port).toBe(587);
      expect(typeof config.smtp.port).toBe('number');
    });

    test('should default SMTP port to 587', () => {
      delete process.env.SMTP_PORT;

      const config = require('../utils/config');
      expect(config.smtp.port).toBe(587);
    });

    test('should set SMTP secure flag from environment', () => {
      process.env.SMTP_SECURE = 'true';

      const config = require('../utils/config');
      expect(config.smtp.secure).toBe(true);
    });

    test('should default SMTP secure to false', () => {
      delete process.env.SMTP_SECURE;

      const config = require('../utils/config');
      expect(config.smtp.secure).toBe(false);
    });

    test('should load SMTP user and password', () => {
      process.env.SMTP_USER = 'user@example.com';
      process.env.SMTP_PASS = 'password123';

      const config = require('../utils/config');
      expect(config.smtp.user).toBe('user@example.com');
      expect(config.smtp.pass).toBe('password123');
    });

    test('should default SMTP_FROM_NAME to ELYVN', () => {
      delete process.env.SMTP_FROM_NAME;

      const config = require('../utils/config');
      expect(config.smtp.fromName).toBe('ELYVN');
    });
  });

  describe('Outreach Configuration', () => {
    test('should parse EMAIL_DAILY_LIMIT as integer', () => {
      process.env.EMAIL_DAILY_LIMIT = '500';

      const config = require('../utils/config');
      expect(config.outreach.dailySendLimit).toBe(500);
      expect(typeof config.outreach.dailySendLimit).toBe('number');
    });

    test('should default EMAIL_DAILY_LIMIT to 300', () => {
      delete process.env.EMAIL_DAILY_LIMIT;

      const config = require('../utils/config');
      expect(config.outreach.dailySendLimit).toBe(300);
    });

    test('should load OUTREACH_SENDER_NAME', () => {
      process.env.OUTREACH_SENDER_NAME = 'John Doe';

      const config = require('../utils/config');
      expect(config.outreach.senderName).toBe('John Doe');
    });

    test('should default OUTREACH_SENDER_NAME to Sohan', () => {
      delete process.env.OUTREACH_SENDER_NAME;

      const config = require('../utils/config');
      expect(config.outreach.senderName).toBe('Sohan');
    });

    test('should load CALCOM_BOOKING_LINK', () => {
      process.env.CALCOM_BOOKING_LINK = 'https://cal.com/custom';

      const config = require('../utils/config');
      expect(config.outreach.bookingLink).toBe('https://cal.com/custom');
    });
  });

  describe('API Configuration', () => {
    test('should load all API keys from environment', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.GOOGLE_MAPS_API_KEY = 'maps-key';
      process.env.RETELL_API_KEY = 'retell-key';
      process.env.TELNYX_API_KEY = 'telnyx-key';
      process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';
      process.env.CALCOM_API_KEY = 'calcom-key';

      const config = require('../utils/config');
      expect(config.apis.anthropicKey).toBe('anthropic-key');
      expect(config.apis.googleMapsKey).toBe('maps-key');
      expect(config.apis.retellKey).toBe('retell-key');
      expect(config.apis.telnyxKey).toBe('telnyx-key');
      expect(config.apis.telegramToken).toBe('telegram-token');
      expect(config.apis.calcomApiKey).toBe('calcom-key');
    });

    test('should handle missing API keys gracefully', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GOOGLE_MAPS_API_KEY;

      const config = require('../utils/config');
      expect(config.apis.anthropicKey).toBeUndefined();
      expect(config.apis.googleMapsKey).toBeUndefined();
    });
  });

  describe('Environment Configuration', () => {
    test('should set isProduction true when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';

      const config = require('../utils/config');
      expect(config.env.isProduction).toBe(true);
    });

    test('should set isProduction false when NODE_ENV is not production', () => {
      process.env.NODE_ENV = 'development';

      const config = require('../utils/config');
      expect(config.env.isProduction).toBe(false);
    });

    test('should default NODE_ENV to development', () => {
      delete process.env.NODE_ENV;

      const config = require('../utils/config');
      expect(config.env.nodeEnv).toBe('development');
    });
  });

  describe('Server Configuration', () => {
    test('should load server port from environment', () => {
      process.env.PORT = '3000';

      const config = require('../utils/config');
      expect(config.server.port).toBe('3000');
    });

    test('should default PORT to 3001', () => {
      delete process.env.PORT;

      const config = require('../utils/config');
      expect(config.server.port).toBe(3001);
    });

    test('should load API key from environment', () => {
      process.env.ELYVN_API_KEY = 'server-api-key';

      const config = require('../utils/config');
      expect(config.server.apiKey).toBe('server-api-key');
    });

    test('should load CORS origins from environment', () => {
      process.env.CORS_ORIGINS = 'https://example.com,https://app.example.com';

      const config = require('../utils/config');
      expect(config.server.corsOrigins).toBe('https://example.com,https://app.example.com');
    });
  });

  describe('Data Retention Configuration', () => {
    test('should parse LOG_RETENTION_DAYS as integer', () => {
      process.env.LOG_RETENTION_DAYS = '14';

      const config = require('../utils/config');
      expect(config.dataRetention.logRetentionDays).toBe(14);
      expect(typeof config.dataRetention.logRetentionDays).toBe('number');
    });

    test('should default LOG_RETENTION_DAYS to 7', () => {
      delete process.env.LOG_RETENTION_DAYS;

      const config = require('../utils/config');
      expect(config.dataRetention.logRetentionDays).toBe(7);
    });

    test('should load audit fallback log path', () => {
      process.env.AUDIT_FALLBACK_LOG = '/var/log/audit.log';

      const config = require('../utils/config');
      expect(config.dataRetention.auditFallbackLog).toBe('/var/log/audit.log');
    });

    test('should default audit fallback log path', () => {
      delete process.env.AUDIT_FALLBACK_LOG;

      const config = require('../utils/config');
      expect(config.dataRetention.auditFallbackLog).toBe('/tmp/elyvn-audit-fallback.log');
    });
  });

  describe('IMAP Configuration', () => {
    test('should load IMAP host from environment', () => {
      process.env.IMAP_HOST = 'imap.custom.com';

      const config = require('../utils/config');
      expect(config.imap.host).toBe('imap.custom.com');
    });

    test('should default IMAP host to imap.gmail.com', () => {
      delete process.env.IMAP_HOST;

      const config = require('../utils/config');
      expect(config.imap.host).toBe('imap.gmail.com');
    });

    test('should parse IMAP port as integer', () => {
      process.env.IMAP_PORT = '993';

      const config = require('../utils/config');
      expect(config.imap.port).toBe(993);
      expect(typeof config.imap.port).toBe('number');
    });

    test('should default IMAP port to 993', () => {
      delete process.env.IMAP_PORT;

      const config = require('../utils/config');
      expect(config.imap.port).toBe(993);
    });
  });

  describe('getBaseUrl', () => {
    test('should return Railway domain if configured', () => {
      process.env.RAILWAY_PUBLIC_DOMAIN = 'app.railway.app';

      const config = require('../utils/config');
      expect(config.getBaseUrl()).toBe('https://app.railway.app');
    });

    test('should return BASE_URL if Railway domain not configured', () => {
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
      process.env.BASE_URL = 'http://localhost:3001';

      const config = require('../utils/config');
      expect(config.getBaseUrl()).toBe('http://localhost:3001');
    });

    test('should default to localhost:3001 if neither is configured', () => {
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
      delete process.env.BASE_URL;

      const config = require('../utils/config');
      expect(config.getBaseUrl()).toBe('http://localhost:3001');
    });

    test('should prefer Railway domain over BASE_URL', () => {
      process.env.RAILWAY_PUBLIC_DOMAIN = 'app.railway.app';
      process.env.BASE_URL = 'http://localhost:3001';

      const config = require('../utils/config');
      expect(config.getBaseUrl()).toBe('https://app.railway.app');
    });
  });

  describe('Claude/AI Configuration', () => {
    test('should load CLAUDE_MODEL from environment', () => {
      process.env.CLAUDE_MODEL = 'claude-opus-4-20250514';

      const config = require('../utils/config');
      expect(config.ai.model).toBe('claude-opus-4-20250514');
    });

    test('should default CLAUDE_MODEL to claude-sonnet-4-20250514', () => {
      delete process.env.CLAUDE_MODEL;

      const config = require('../utils/config');
      expect(config.ai.model).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('Monitoring Configuration', () => {
    test('should set sentryEnabled to true when SENTRY_DSN is configured', () => {
      process.env.SENTRY_DSN = 'https://sentry.io/project/123';

      const config = require('../utils/config');
      expect(config.monitoring.sentryEnabled).toBe(true);
    });

    test('should set sentryEnabled to false when SENTRY_DSN is not configured', () => {
      delete process.env.SENTRY_DSN;

      const config = require('../utils/config');
      expect(config.monitoring.sentryEnabled).toBe(false);
    });
  });

  describe('Business Configuration', () => {
    test('should load BUSINESS_ADDRESS from environment', () => {
      process.env.BUSINESS_ADDRESS = '123 Main St, City, State';

      const config = require('../utils/config');
      expect(config.business.address).toBe('123 Main St, City, State');
    });

    test('should default BUSINESS_ADDRESS to empty string', () => {
      delete process.env.BUSINESS_ADDRESS;

      const config = require('../utils/config');
      expect(config.business.address).toBe('');
    });
  });

  describe('Email Tracking Configuration', () => {
    test('should load BASE_URL for email tracking', () => {
      process.env.BASE_URL = 'https://app.example.com';

      const config = require('../utils/config');
      expect(config.emailTracking.baseUrl).toBe('https://app.example.com');
    });

    test('should default BASE_URL to localhost:3001', () => {
      delete process.env.BASE_URL;

      const config = require('../utils/config');
      expect(config.emailTracking.baseUrl).toBe('http://localhost:3001');
    });
  });
});
