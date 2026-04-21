/**
 * Centralized Configuration Module
 * Consolidates all environment variable defaults and application config
 */

module.exports = {
  // Email & SMTP Configuration (used for authentication/verification)
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME || 'ELYVN',
  },

  // Claude/AI Configuration
  ai: {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
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

  // Plan Limits & Configuration
  plans: {
    trial: {
      name: 'Trial',
      price: 0,
      calls: 50,
      sms: 100,
    },
    solo: {
      name: 'Solo',
      price: 199,
      productId: process.env.DODO_PRODUCT_SOLO || 'pdt_0NcSVPcrrPE9CjPnCdjJC',
      calls: 100,
      sms: 300,
    },
    starter: {
      name: 'Starter',
      price: 349,
      productId: process.env.DODO_PRODUCT_STARTER || 'pdt_0NcSLxjRSsPJST0uTn8kN',
      calls: 500,
      sms: 1000,
    },
    pro: {
      name: 'Pro',
      price: 349,
      productId: process.env.DODO_PRODUCT_PRO || 'pdt_0NcSLxjRSsPJST0uTn8kN',
      calls: 1500,
      sms: 3000,
    },
    premium: {
      name: 'Premium',
      price: 599,
      productId: process.env.DODO_PRODUCT_PREMIUM || 'pdt_premium_placeholder',
      calls: -1, // unlimited
      sms: -1,
    },
    // Legacy/Alias support
    growth: {
      name: 'Growth',
      price: 199,
      productId: process.env.DODO_PRODUCT_GROWTH || 'pdt_0NcSVPcrrPE9CjPnCdjJC',
      calls: 100,
      sms: 300,
    },
    elite: {
      name: 'Elite',
      price: 599,
      productId: process.env.DODO_PRODUCT_ELITE || 'pdt_0NcSMTlJqIJcQsneYDYsi',
      calls: -1,
      sms: -1,
    },
    scale: {
      name: 'Premium',
      price: 999,
      calls: -1,
      sms: -1,
    }
  },

  /**
   * Get the full base URL for the application
   * Used for email tracking and redirects
   */
  getBaseUrl() {
    if (this.deployment.railwayPublicDomain) {
      return `https://${this.deployment.railwayPublicDomain}`;
    }
    return process.env.BASE_URL || 'http://localhost:3001';
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
