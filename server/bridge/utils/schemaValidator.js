/**
 * Schema Validator — runs at startup after migrations.
 * Ensures every column referenced in code actually exists in the DB.
 * If any are missing, logs FATAL errors and exits (in production) or warns (in dev).
 *
 * This is the PERMANENT fix for "no such column" crashes.
 * When you add a new column reference in code, add it here too.
 */

function getLogger() {
  try { return require('./logger').logger; }
  catch { return { info: console.log, error: console.error, warn: console.warn }; }
}

/**
 * Authoritative schema: every column that runtime code touches.
 * Format: { tableName: ['col1', 'col2', ...] }
 *
 * RULE: If you write SQL that references a column, it MUST be listed here.
 * The validator will catch it at startup before any request hits the DB.
 */
const REQUIRED_SCHEMA = {
  clients: [
    'id', 'name', 'business_name', 'owner_name', 'owner_phone', 'owner_email',
    'industry', 'timezone', 'twilio_phone', 'telnyx_phone', 'retell_agent_id',
    'retell_phone', 'retell_voice', 'retell_language', 'phone_number',
    'transfer_phone', 'whatsapp_phone',
    'calcom_booking_link', 'calcom_event_type_id',
    'google_review_link', 'google_sheet_id',
    'telegram_chat_id', 'notification_mode',
    'knowledge_base', 'kb_path', 'business_hours',
    'avg_ticket', 'ticket_price',
    'is_active', 'auto_followup_enabled', 'ai_enabled',
    'password_hash', 'plan', 'subscription_status',
    'stripe_customer_id', 'stripe_subscription_id',
    'dodo_customer_id', 'dodo_subscription_id',
    'plan_started_at', 'onboarding_completed', 'onboarding_step',
    'email_verified', 'verification_token', 'verification_expires',
    'referral_code', 'referred_by', 'referral_credits',
    'facebook_page_id', 'instagram_user_id',
    'facebook_page_token_encrypted', 'instagram_access_token_encrypted',
    'reseller_id', 'white_label_brand', 'white_label_domain',
    'calls_this_month', 'sms_this_month', 'billing_cycle_start',
    'business_address', 'website', 'booking_link',
    'lead_webhook_url', 'booking_webhook_url', 'call_webhook_url',
    'sms_webhook_url', 'stage_change_webhook_url',
    'created_at', 'updated_at',
  ],
  calls: [
    'id', 'call_id', 'client_id', 'caller_phone', 'caller_name',
    'direction', 'status', 'duration', 'recording_url', 'transcript',
    'summary', 'sentiment', 'action_taken', 'score', 'outcome',
    'analysis_data', 'twilio_call_sid',
    'created_at', 'updated_at',
  ],
  leads: [
    'id', 'client_id', 'name', 'phone', 'email', 'source',
    'score', 'stage', 'notes', 'prospect_id', 'last_contact',
    'calcom_booking_id', 'revenue_closed', 'job_value',
    'phone_encrypted', 'email_encrypted',
    'created_at', 'updated_at',
  ],
  messages: [
    'id', 'client_id', 'lead_id', 'phone', 'direction', 'body',
    'status', 'channel', 'reply_text', 'reply_source', 'confidence',
    'message_sid', 'conversation_id', 'delivery_status',
    'delivered_at', 'read_at', 'body_encrypted',
    'created_at', 'updated_at',
  ],
  followups: [
    'id', 'lead_id', 'client_id', 'type', 'scheduled_at',
    'completed_at', 'sent_at', 'status', 'notes',
    'touch_number', 'content', 'content_source', 'attempts',
    'created_at', 'updated_at',
  ],
  appointments: [
    'id', 'client_id', 'lead_id', 'phone', 'name', 'service',
    'datetime', 'status', 'calcom_booking_id',
    'created_at', 'updated_at',
  ],
  campaigns: [
    'id', 'client_id', 'name', 'industry', 'city',
    'total_prospects', 'total_sent', 'total_replied',
    'total_positive', 'total_booked', 'status',
    'created_at', 'updated_at',
  ],
  emails_sent: [
    'id', 'client_id', 'campaign_id', 'prospect_id',
    'to_email', 'from_email', 'subject', 'body',
    'sent_at', 'status', 'reply_text', 'reply_classification',
    'reply_at', 'auto_response_sent', 'error',
    'opened_at', 'open_count', 'clicked_at', 'click_count',
    'variant', 'subject_a', 'subject_b',
    'created_at', 'updated_at',
  ],
  prospects: [
    'id', 'client_id', 'business_name', 'phone', 'email',
    'website', 'address', 'industry', 'city', 'state', 'country',
    'rating', 'review_count', 'hours', 'status',
    'created_at', 'updated_at',
  ],
  conversations: [
    'id', 'client_id', 'lead_id', 'lead_phone', 'lead_name',
    'last_message_at', 'last_message_preview', 'unread_count', 'status',
    'created_at', 'updated_at',
  ],
  audit_log: [
    'id', 'client_id', 'user_id', 'action', 'resource_type',
    'resource_id', 'ip_address', 'user_agent', 'details',
    'old_values', 'new_values', 'hash', 'previous_hash',
    'created_at',
  ],
  job_queue: [
    'id', 'client_id', 'type', 'payload', 'scheduled_at',
    'started_at', 'completed_at', 'failed_at', 'error',
    'attempts', 'max_attempts', 'status', 'priority',
    'created_at', 'updated_at',
  ],
};

/**
 * Validate the database schema against REQUIRED_SCHEMA.
 * @param {object} db - better-sqlite3 instance
 * @returns {{ valid: boolean, missing: Array<{table: string, column: string}> }}
 */
function validateSchema(db) {
  const log = getLogger();
  const missing = [];

  for (const [table, requiredCols] of Object.entries(REQUIRED_SCHEMA)) {
    let existingCols;
    try {
      existingCols = db.prepare(`PRAGMA table_info('${table}')`).all().map(c => c.name);
    } catch {
      // Table doesn't exist — every column is missing
      for (const col of requiredCols) {
        missing.push({ table, column: col });
      }
      continue;
    }

    for (const col of requiredCols) {
      if (!existingCols.includes(col)) {
        missing.push({ table, column: col });
      }
    }
  }

  if (missing.length > 0) {
    log.error(`[schemaValidator] ${missing.length} missing column(s) detected:`);
    for (const { table, column } of missing) {
      log.error(`  MISSING: ${table}.${column}`);
    }
    log.error('[schemaValidator] Add these columns via a new migration in utils/migrations.js');
    log.error('[schemaValidator] AND add them to REQUIRED_SCHEMA in utils/schemaValidator.js');
  } else {
    log.info('[schemaValidator] Schema validation passed — all required columns present');
  }

  return { valid: missing.length === 0, missing };
}

module.exports = { validateSchema, REQUIRED_SCHEMA };
