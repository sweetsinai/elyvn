/**
 * Centralized Configuration Module
 * Consolidates all environment variable defaults and application config
 */

module.exports = {
  // Email & SMTP Configuration
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME || 'ELYVN',
  },

  // Outreach Configuration
  outreach: {
    dailySendLimit: parseInt(process.env.EMAIL_DAILY_LIMIT || '300', 10),
    senderName: process.env.OUTREACH_SENDER_NAME || 'Sohan',
    bookingLink: process.env.CALCOM_BOOKING_LINK || 'https://cal.com/elyvn/demo',
  },

  // Claude/AI Configuration
  ai: {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  },

  // Email Tracking Configuration
  emailTracking: {
    baseUrl: process.env.BASE_URL || 'http://localhost:3001',
  },

  // IMAP Configuration (for email sync)
  imap: {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
  },

  // Data Retention Configuration
  dataRetention: {
    logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '7', 10),
    auditFallbackLog: process.env.AUDIT_FALLBACK_LOG || '/tmp/elyvn-audit-fallback.log',
  },

  // Environment Configuration
  env: {
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
  },

  // Server Configuration
  server: {
    port: process.env.PORT || 3001,
    apiKey: process.env.ELYVN_API_KEY,
    corsOrigins: process.env.CORS_ORIGINS,
  },

  // Business Configuration
  business: {
    address: process.env.BUSINESS_ADDRESS || '',
  },

  // External APIs
  apis: {
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    retellKey: process.env.RETELL_API_KEY,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    calcomApiKey: process.env.CALCOM_API_KEY,
  },

  // Deployment Configuration
  deployment: {
    railwayPublicDomain: process.env.RAILWAY_PUBLIC_DOMAIN,
  },

  // Monitoring Configuration
  monitoring: {
    sentryEnabled: !!process.env.SENTRY_DSN,
  },

  /**
   * Get the full base URL for the application
   * Used for email tracking and redirects
   */
  getBaseUrl() {
    if (this.deployment.railwayPublicDomain) {
      return `https://${this.deployment.railwayPublicDomain}`;
    }
    return this.emailTracking.baseUrl;
  },

  /**
   * Check if all critical APIs are configured
   */
  isFullyConfigured() {
    return !!(
      this.apis.anthropicKey &&
      this.apis.googleMapsKey &&
      this.apis.retellKey &&
      this.apis.twilioAccountSid &&
      this.apis.twilioAuthToken
    );
  },
};
