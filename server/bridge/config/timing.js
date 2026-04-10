/**
 * Centralized Timing Configuration
 * All timeout, interval, and delay values for production reliability
 */

module.exports = {
  // ===== API & Network Timeouts =====
  // External service request timeouts (Retell, Anthropic, etc.)
  ANTHROPIC_TIMEOUT: process.env.ANTHROPIC_TIMEOUT ? parseInt(process.env.ANTHROPIC_TIMEOUT) : 30000, // Anthropic API call timeout (30 seconds)
  API_TIMEOUT_MS: 5000,           // Generic API call timeout (5 seconds)
  FETCH_TIMEOUT: process.env.FETCH_TIMEOUT ? parseInt(process.env.FETCH_TIMEOUT) : 5000,  // Generic fetch timeout for scraping (5 seconds)
  RETELL_CALL_TIMEOUT_MS: 15000,  // Retell outbound call creation timeout (15 seconds)

  // ===== Job Queue & Processing =====
  JOB_HANDLER_TIMEOUT: 30000,      // Max execution time for individual job handlers (30 seconds)
  JOB_PROCESSOR_INTERVAL: 15000,   // Check for due jobs every 15 seconds
  JOB_CLEANUP_DELAY_MS: 100,       // Delay between processing consecutive jobs (100ms)
  STALLED_JOB_THRESHOLD_MS: 30 * 60 * 1000,  // Jobs stuck in 'processing' for 30+ minutes are recovered
  STALE_JOB_THRESHOLD_MS: 1 * 60 * 60 * 1000, // Jobs pending for 1+ hour are rescheduled
  JOB_RETRY_BACKOFF_BASE_MS: 60000, // Base exponential backoff: 2^n * 60 seconds

  // ===== SMS =====
  SMS_MAX_LENGTH: 1600,             // Max SMS length (10 concatenated segments, Telnyx/Twilio compat)

  // ===== Email =====
  EMAIL_DAILY_LIMIT: process.env.EMAIL_DAILY_LIMIT ? parseInt(process.env.EMAIL_DAILY_LIMIT) : 300, // Max outbound emails per day

  // ===== SMS Rate Limiting =====
  SMS_MIN_GAP_MS: 5 * 60 * 1000,   // Minimum 5 minutes between SMS to same number (rate limit)
  SMS_RATE_LIMIT_CLEANUP_MS: 10 * 60 * 1000, // Clean stale rate limit entries every 10 minutes
  SMS_MAX_RATE_LIMIT_ENTRIES: 5000, // Cap in-memory rate limit map to prevent memory leaks

  // ===== Brain & Resilience =====
  BRAIN_LOCK_TIMEOUT_MS: 10000,    // Lock timeout for concurrent brain operations (10 seconds)
  RESILIENCE_RETRY_INITIAL_DELAY_MS: 1000, // Initial delay for exponential backoff (1 second)
  CIRCUIT_BREAKER_FAILURE_WINDOW_MS: 60000, // Time window to count failures (1 minute)
  CIRCUIT_BREAKER_COOLDOWN_MS: 30000, // Cooldown period when circuit opens (30 seconds)

  // ===== Rate Limiting =====
  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS ? parseInt(process.env.RATE_LIMIT_WINDOW_MS) : 60000,     // Rate limit window (1 minute) = 60,000ms
  RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) : 100, // Max requests per window for general limiter
  RATE_LIMIT_CLEANUP_MS: 5 * 60 * 1000, // Cleanup rate limiter entries every 5 minutes
  RATE_LIMIT_MAX_ENTRIES: 10000,   // Cap rate limiter entries

  // ===== Scheduler Intervals =====
  // Scheduled tasks that run at specific times each day
  SCHEDULER_DAILY_SUMMARY_HOUR: 19, // 7 PM daily summary
  SCHEDULER_DAILY_INTERVAL_MS: 24 * 60 * 60 * 1000, // Repeat every 24 hours
  SCHEDULER_WEEKLY_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000, // Repeat every 7 days
  SCHEDULER_DAILY_REVIEW_HOUR: 9,  // 9 AM daily lead review
  SCHEDULER_DAILY_OUTREACH_HOUR: 10, // 10 AM daily outreach
  SCHEDULER_DAILY_SCORING_HOUR: 6, // 6 AM daily lead scoring
  SCHEDULER_DATA_RETENTION_HOUR: 3, // 3 AM data retention cleanup

  // ===== Scheduler Recurring Tasks =====
  SCHEDULER_FOLLOWUP_INTERVAL_MS: 5 * 60 * 1000, // Check due follow-ups every 5 minutes
  SCHEDULER_APPOINTMENT_REMINDER_INTERVAL_MS: 2 * 60 * 1000, // Check appointment reminders every 2 minutes
  SCHEDULER_REPLY_CHECK_INTERVAL_MS: 30 * 60 * 1000, // Check for replies every 30 minutes

  // ===== Appointment Reminders =====
  APPOINTMENT_REMINDER_24H_MS: 24 * 60 * 60 * 1000, // 24 hours before appointment
  APPOINTMENT_REMINDER_2H_MS: 2 * 60 * 60 * 1000,  // 2 hours before appointment

  // ===== Outreach & Email =====
  OUTREACH_BATCH_DELAY_MS: 100,    // Delay between email batches (100ms)
  OUTREACH_COLD_EMAIL_INTERVAL_MS: 2 * 60 * 1000, // 2 minutes between cold email sends
  OUTREACH_IMAP_LOOKBACK_MS: 24 * 60 * 60 * 1000, // Check for replies from last 24 hours
  OUTREACH_DELAY_3_DAYS_MS: 3 * 24 * 60 * 60 * 1000, // 3 days for initial follow-up delay
  OUTREACH_DELAY_1_DAY_MS: 24 * 60 * 60 * 1000, // 1 day for standard follow-up
  OUTREACH_INITIAL_REPLY_TIMEOUT_MS: 5000, // Timeout for initial email verification fetch

  // ===== Duplicate Prevention =====
  // Check for recent duplicates to prevent queue retry duplication
  DUPLICATE_SMS_LOOKBACK_MS: 5 * 60 * 1000, // 5 minutes for SMS deduplication
  DUPLICATE_CALL_LOOKBACK_MS: 5 * 60 * 1000, // 5 minutes for call deduplication
  DUPLICATE_EMAIL_LOOKBACK_MS: 5 * 60 * 1000, // 5 minutes for email deduplication

  // ===== Data Retention & Cleanup =====
  DATA_RETENTION_JOB_RETENTION_DAYS: 7, // Keep completed/failed jobs for 7 days
  BACKUP_INTERVAL_HOURS: 24, // Daily backups
  DATA_RETENTION_DAILY_INTERVAL_MS: 24 * 60 * 60 * 1000, // Run data retention daily

  // ===== Brain Throttling & Delays =====
  BRAIN_FOLLOWUP_THROTTLE_MS: 2000, // 2 second delay between brain followup calls
  BRAIN_DAILY_REVIEW_THROTTLE_MS: 2000, // 2 second delay between brain review calls
  SCRAPER_RETRY_DELAY_MS: 2000,   // 2 second delay between scraper retries

  // ===== WebSocket & Polling =====
  WEBSOCKET_HEARTBEAT_INTERVAL_MS: 30000, // Send heartbeat every 30 seconds

  // ===== Auto-Classification =====
  AUTO_CLASSIFY_INTERVAL_MS: 5 * 60 * 1000, // Check for unclassified replies every 5 minutes

  // ===== Call Transfer =====
  TRANSFER_DIAL_TIMEOUT_S: 30,        // Seconds to ring transfer target before voicemail fallback
  TRANSFER_VOICEMAIL_MAX_LENGTH_S: 120, // Max voicemail recording length (2 minutes)

  // ===== Graceful Shutdown =====
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: 5000, // Force shutdown after 5 seconds of waiting

  // ===== Telegram Callback Rate Limiting =====
  TELEGRAM_CALLBACK_RATE_LIMIT: 10,      // Max callbacks per minute per chatId
  TELEGRAM_CALLBACK_RATE_WINDOW_MS: 60000, // 1 minute

  // ===== Onboarding Rate Limiting =====
  ONBOARD_RATE_LIMIT: 5,                  // Max onboards per minute per IP
  ONBOARD_RATE_WINDOW_MS: 60000,          // 1 minute

  // ===== Form Submission Rate Limiting =====
  FORM_RATE_LIMIT: 10,                    // Max form submissions per window per IP
  FORM_RATE_WINDOW_MS: 60000,             // 1 minute
  FORM_SPEED_TO_LEAD_DEDUP_WINDOW_MS: 5 * 60 * 1000, // 5 minutes dedup window

  // ===== Auth / Login Lockout =====
  LOGIN_MAX_ATTEMPTS: 5,                  // Failed attempts before lockout
  LOGIN_LOCKOUT_MS: 15 * 60 * 1000,       // 15 minutes lockout
  RESEND_VERIFICATION_COOLDOWN_MS: 5 * 60 * 1000, // 5 minutes between resend requests
};
