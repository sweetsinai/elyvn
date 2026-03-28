/**
 * SQLite Migration Framework
 * Tracks applied migrations in a `_migrations` table.
 * Each migration is a function that receives the db instance.
 */

const migrations = [
  {
    id: '001_base_tables',
    description: 'Ensure core tables exist (clients, calls, leads, messages, followups)',
    up(db) {
      // These tables should already exist from initial setup.
      // This migration ensures the schema is correct on fresh installs.
      db.exec(`
        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          industry TEXT,
          owner_name TEXT,
          owner_phone TEXT,
          owner_email TEXT,
          twilio_phone TEXT,
          retell_agent_id TEXT,
          knowledge_base TEXT,
          google_review_link TEXT,
          business_hours TEXT,
          telegram_chat_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY,
          call_id TEXT UNIQUE,
          client_id TEXT,
          caller_phone TEXT,
          direction TEXT DEFAULT 'inbound',
          status TEXT,
          duration INTEGER,
          recording_url TEXT,
          transcript TEXT,
          summary TEXT,
          sentiment TEXT,
          action_taken TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          name TEXT,
          phone TEXT,
          email TEXT,
          source TEXT,
          score INTEGER DEFAULT 0,
          stage TEXT DEFAULT 'new',
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          phone TEXT,
          direction TEXT,
          body TEXT,
          status TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS followups (
          id TEXT PRIMARY KEY,
          lead_id TEXT,
          client_id TEXT,
          type TEXT,
          scheduled_at TEXT,
          completed_at TEXT,
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: '002_appointments',
    description: 'Create appointments table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS appointments (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          lead_id TEXT,
          phone TEXT,
          name TEXT,
          service TEXT,
          datetime TEXT,
          status TEXT DEFAULT 'confirmed',
          calcom_booking_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: '003_sms_opt_outs',
    description: 'Create SMS opt-out tracking table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sms_opt_outs (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          client_id TEXT NOT NULL,
          opted_out_at TEXT DEFAULT (datetime('now')),
          reason TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(phone, client_id)
        );
      `);
    },
  },
  {
    id: '004_job_queue',
    description: 'Create persistent job queue table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          payload TEXT,
          scheduled_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          failed_at TEXT,
          error TEXT,
          attempts INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 3,
          status TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_job_queue_status_scheduled
          ON job_queue(status, scheduled_at);
      `);
    },
  },
  {
    id: '005_outreach_tables',
    description: 'Create prospects, campaigns, campaign_prospects, emails_sent tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prospects (
          id TEXT PRIMARY KEY,
          business_name TEXT,
          phone TEXT,
          email TEXT,
          website TEXT,
          address TEXT,
          industry TEXT,
          city TEXT,
          state TEXT,
          country TEXT DEFAULT 'US',
          rating REAL,
          review_count INTEGER,
          hours TEXT,
          status TEXT DEFAULT 'scraped',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS campaigns (
          id TEXT PRIMARY KEY,
          name TEXT,
          industry TEXT,
          city TEXT,
          total_prospects INTEGER DEFAULT 0,
          total_sent INTEGER DEFAULT 0,
          total_replied INTEGER DEFAULT 0,
          total_positive INTEGER DEFAULT 0,
          total_booked INTEGER DEFAULT 0,
          status TEXT DEFAULT 'draft',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS campaign_prospects (
          id TEXT PRIMARY KEY,
          campaign_id TEXT,
          prospect_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS emails_sent (
          id TEXT PRIMARY KEY,
          campaign_id TEXT,
          prospect_id TEXT,
          to_email TEXT,
          from_email TEXT,
          subject TEXT,
          body TEXT,
          sent_at TEXT,
          status TEXT DEFAULT 'draft',
          reply_text TEXT,
          reply_classification TEXT,
          reply_at TEXT,
          auto_response_sent INTEGER DEFAULT 0,
          error TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: '006_indexes',
    description: 'Add performance indexes',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_calls_call_id ON calls(call_id);
        CREATE INDEX IF NOT EXISTS idx_calls_caller_phone ON calls(caller_phone);
        CREATE INDEX IF NOT EXISTS idx_calls_client_id ON calls(client_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_id, phone);
        CREATE INDEX IF NOT EXISTS idx_messages_client_phone ON messages(client_id, phone);
        CREATE INDEX IF NOT EXISTS idx_followups_lead_id ON followups(lead_id);
        CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
        CREATE INDEX IF NOT EXISTS idx_emails_sent_status ON emails_sent(status);
        CREATE INDEX IF NOT EXISTS idx_emails_sent_prospect ON emails_sent(prospect_id);
      `);
    },
  },
  {
    id: '007_client_columns',
    description: 'Add google_review_link and business_hours columns to clients',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!cols.includes('google_review_link')) {
        db.exec('ALTER TABLE clients ADD COLUMN google_review_link TEXT');
      }
      if (!cols.includes('business_hours')) {
        db.exec('ALTER TABLE clients ADD COLUMN business_hours TEXT');
      }
    },
  },
  {
    id: '008_leads_prospect_id',
    description: 'Add prospect_id and last_contact columns to leads for outreach→lead linkage',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('leads')").all().map(c => c.name);
      if (!cols.includes('prospect_id')) {
        db.exec('ALTER TABLE leads ADD COLUMN prospect_id TEXT');
      }
      if (!cols.includes('last_contact')) {
        db.exec('ALTER TABLE leads ADD COLUMN last_contact TEXT');
      }
      if (!cols.includes('calcom_booking_id')) {
        db.exec('ALTER TABLE leads ADD COLUMN calcom_booking_id TEXT');
      }
      // Index for prospect lookups
      db.exec('CREATE INDEX IF NOT EXISTS idx_leads_prospect_id ON leads(prospect_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)');
    },
  },
  {
    id: '009_emails_sent_indexes',
    description: 'Add indexes on emails_sent for reply matching',
    up(db) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_emails_sent_to_email ON emails_sent(to_email)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_emails_sent_reply ON emails_sent(reply_text, reply_classification)');
    },
  },
  {
    id: '010_email_tracking_columns',
    description: 'Add email tracking columns (opens, clicks, variants)',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('emails_sent')").all().map(c => c.name);
      if (!cols.includes('opened_at')) {
        db.exec('ALTER TABLE emails_sent ADD COLUMN opened_at TEXT');
      }
      if (!cols.includes('open_count')) {
        db.exec('ALTER TABLE emails_sent ADD COLUMN open_count INTEGER DEFAULT 0');
      }
      if (!cols.includes('clicked_at')) {
        db.exec('ALTER TABLE emails_sent ADD COLUMN clicked_at TEXT');
      }
      if (!cols.includes('click_count')) {
        db.exec('ALTER TABLE emails_sent ADD COLUMN click_count INTEGER DEFAULT 0');
      }
      if (!cols.includes('variant')) {
        db.exec('ALTER TABLE emails_sent ADD COLUMN variant TEXT');
      }
      // Add column for tracking subject A/B
      if (!cols.includes('subject_a')) {
        db.exec('ALTER TABLE emails_sent ADD COLUMN subject_a TEXT');
      }
      if (!cols.includes('subject_b')) {
        db.exec('ALTER TABLE emails_sent ADD COLUMN subject_b TEXT');
      }
    },
  },
  {
    id: '011_unique_leads_client_phone',
    description: 'Add unique index on leads(client_id, phone) to prevent duplicate leads',
    up(db) {
      // Use IF NOT EXISTS to be idempotent
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone_unique ON leads(client_id, phone)');
    },
  },
  {
    id: '012_client_api_keys',
    description: 'Create per-client API key authentication table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS client_api_keys (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          api_key_hash TEXT NOT NULL,
          label TEXT DEFAULT 'default',
          permissions TEXT DEFAULT '["read","write"]',
          rate_limit INTEGER DEFAULT 120,
          is_active INTEGER DEFAULT 1,
          last_used_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT,
          FOREIGN KEY (client_id) REFERENCES clients(id)
        );
        CREATE INDEX IF NOT EXISTS idx_client_api_keys_hash ON client_api_keys(api_key_hash);
        CREATE INDEX IF NOT EXISTS idx_client_api_keys_client ON client_api_keys(client_id);
      `);
    },
  },
  {
    id: '013_audit_log',
    description: 'Create audit logging table for security events',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          user_id TEXT,
          action TEXT NOT NULL,
          resource_type TEXT,
          resource_id TEXT,
          ip_address TEXT,
          user_agent TEXT,
          details TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_audit_log_client ON audit_log(client_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);
      `);
    },
  },
  {
    id: '014_schema_completion',
    description: 'Add missing columns used by codebase but not in original schema',
    up(db) {
      // calls table: missing score, outcome
      const callCols = db.prepare("PRAGMA table_info('calls')").all().map(c => c.name);
      if (!callCols.includes('score')) db.exec('ALTER TABLE calls ADD COLUMN score INTEGER');
      if (!callCols.includes('outcome')) db.exec('ALTER TABLE calls ADD COLUMN outcome TEXT');

      // messages table: missing lead_id, channel, reply_text, reply_source, confidence
      const msgCols = db.prepare("PRAGMA table_info('messages')").all().map(c => c.name);
      if (!msgCols.includes('lead_id')) db.exec('ALTER TABLE messages ADD COLUMN lead_id TEXT');
      if (!msgCols.includes('channel')) db.exec("ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'sms'");
      if (!msgCols.includes('reply_text')) db.exec('ALTER TABLE messages ADD COLUMN reply_text TEXT');
      if (!msgCols.includes('reply_source')) db.exec('ALTER TABLE messages ADD COLUMN reply_source TEXT');
      if (!msgCols.includes('confidence')) db.exec('ALTER TABLE messages ADD COLUMN confidence REAL');
      if (!msgCols.includes('updated_at')) db.exec("ALTER TABLE messages ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");

      // followups table: missing touch_number, content, content_source, sent_at, updated_at
      const fuCols = db.prepare("PRAGMA table_info('followups')").all().map(c => c.name);
      if (!fuCols.includes('touch_number')) db.exec('ALTER TABLE followups ADD COLUMN touch_number INTEGER');
      if (!fuCols.includes('content')) db.exec('ALTER TABLE followups ADD COLUMN content TEXT');
      if (!fuCols.includes('content_source')) db.exec('ALTER TABLE followups ADD COLUMN content_source TEXT');
      if (!fuCols.includes('sent_at')) db.exec('ALTER TABLE followups ADD COLUMN sent_at TEXT');
      if (!fuCols.includes('updated_at')) db.exec("ALTER TABLE followups ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");

      // clients table: missing calcom_booking_link, twilio_phone, retell_phone, is_active, calcom_event_type_id, avg_ticket
      const clientCols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!clientCols.includes('calcom_booking_link')) db.exec('ALTER TABLE clients ADD COLUMN calcom_booking_link TEXT');
      if (!clientCols.includes('business_name')) db.exec('ALTER TABLE clients ADD COLUMN business_name TEXT');
      if (!clientCols.includes('twilio_phone')) db.exec("ALTER TABLE clients ADD COLUMN twilio_phone TEXT");
      if (!clientCols.includes('retell_phone')) db.exec('ALTER TABLE clients ADD COLUMN retell_phone TEXT');
      if (!clientCols.includes('is_active')) db.exec('ALTER TABLE clients ADD COLUMN is_active INTEGER DEFAULT 1');
      if (!clientCols.includes('calcom_event_type_id')) db.exec('ALTER TABLE clients ADD COLUMN calcom_event_type_id TEXT');
      if (!clientCols.includes('avg_ticket')) db.exec('ALTER TABLE clients ADD COLUMN avg_ticket REAL DEFAULT 0');
    },
  },
  {
    id: '015_performance_indexes_retention',
    description: 'Add missing performance indexes and data retention policy',
    up(db) {
      // Missing indexes on high-query columns
      db.exec('CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(client_id, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(client_id, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_followups_status_scheduled ON followups(status, scheduled_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_client_status ON appointments(client_id, status)');
      // Handle status→stage column rename (older deployments may have 'status', newer have 'stage')
      const leadCols = db.prepare("PRAGMA table_info('leads')").all().map(c => c.name);
      if (leadCols.includes('stage')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(client_id, stage)');
      } else if (leadCols.includes('status')) {
        db.exec("ALTER TABLE leads RENAME COLUMN status TO stage");
        db.exec('CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(client_id, stage)');
      }
      if (leadCols.includes('score')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(client_id, score)');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_prospects_city_industry ON prospects(city, industry)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_emails_sent_campaign ON emails_sent(campaign_id, status)');
    },
  },
  {
    id: '016_weekly_reports_table',
    description: 'Create weekly_reports table for storing aggregated weekly statistics',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS weekly_reports (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          week_start TEXT NOT NULL,
          week_end TEXT NOT NULL,
          calls_answered INTEGER DEFAULT 0,
          appointments_booked INTEGER DEFAULT 0,
          messages_handled INTEGER DEFAULT 0,
          estimated_revenue REAL DEFAULT 0,
          missed_call_rate REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (client_id) REFERENCES clients(id)
        );
        CREATE INDEX IF NOT EXISTS idx_weekly_reports_client_week ON weekly_reports(client_id, week_end);
      `);
    },
  },
  {
    id: '017_emails_sent_unique_constraint',
    description: 'Add UNIQUE index on emails_sent(prospect_id, campaign_id) to prevent duplicate sends',
    up(db) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_sent_prospect_campaign_unique
          ON emails_sent(prospect_id, campaign_id)
      `);
    },
  },
  {
    id: '018_data_integrity_indexes_and_retention',
    description: 'Add foreign key enforcement, performance indexes, and data retention policy table',
    up(db) {
      // Enable foreign key constraints
      db.exec('PRAGMA foreign_keys = ON');

      // Create performance indexes for common query patterns
      // leads: commonly queried by client_id and date range
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_leads_client_created_at
          ON leads(client_id, created_at)
      `);

      // messages: commonly queried by phone and date range
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_phone_created_at
          ON messages(phone, created_at)
      `);

      // calls: commonly queried by client_id and date range
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_calls_client_created_at
          ON calls(client_id, created_at)
      `);

      // emails_sent: commonly queried by prospect_id and campaign_id together
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_emails_sent_prospect_campaign_created_at
          ON emails_sent(prospect_id, campaign_id)
      `);

      // Create data retention policy table with default retention periods
      db.exec(`
        CREATE TABLE IF NOT EXISTS data_retention_policy (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL UNIQUE,
          retention_days INTEGER NOT NULL DEFAULT 365,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        -- Insert default retention policies (ignore duplicates if already exist)
        INSERT OR IGNORE INTO data_retention_policy (table_name, retention_days) VALUES
          ('messages', 90),
          ('calls', 365),
          ('emails_sent', 180),
          ('audit_log', 90),
          ('lead_timeline', 180);
      `);

      // Document foreign key relationships in comments for reference:
      // - calls.client_id → clients.id
      // - leads.client_id → clients.id
      // - leads.prospect_id → prospects.id
      // - messages.client_id → clients.id
      // - messages.lead_id → leads.id
      // - followups.lead_id → leads.id
      // - followups.client_id → clients.id
      // - appointments.client_id → clients.id
      // - appointments.lead_id → leads.id
      // - campaign_prospects.campaign_id → campaigns.id
      // - campaign_prospects.prospect_id → prospects.id
      // - emails_sent.campaign_id → campaigns.id
      // - emails_sent.prospect_id → prospects.id
      // - sms_opt_outs.client_id → clients.id
      // - client_api_keys.client_id → clients.id
      // - audit_log.client_id → clients.id
      // - weekly_reports.client_id → clients.id
    },
  },
  {
    id: '019_transfer_phone_column',
    description: 'Add transfer_phone to clients for call forwarding destination',
    up(db) {
      const clientCols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!clientCols.includes('transfer_phone')) {
        db.exec('ALTER TABLE clients ADD COLUMN transfer_phone TEXT');
      }
    },
  },
  {
    id: '020_telnyx_phone_column',
    description: 'Add telnyx_phone to clients for Telnyx SMS provider migration',
    up(db) {
      const clientCols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!clientCols.includes('telnyx_phone')) {
        db.exec('ALTER TABLE clients ADD COLUMN telnyx_phone TEXT');
      }
    },
  },
  {
    id: '021_message_sid_and_integrity',
    description: 'Add message_sid column and enforce data integrity constraints',
    up(db) {
      // Add missing message_sid column used by SMS routes
      const msgCols = db.prepare("PRAGMA table_info('messages')").all().map(c => c.name);
      if (!msgCols.includes('message_sid')) {
        db.exec('ALTER TABLE messages ADD COLUMN message_sid TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(message_sid)');
      }

      // Add missing indexes for foreign key lookups
      db.exec('CREATE INDEX IF NOT EXISTS idx_followups_client_id ON followups(client_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sms_opt_outs_client_id ON sms_opt_outs(client_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_lead_id ON appointments(lead_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id)');

      // Note: SQLite does not support adding FK constraints to existing tables via ALTER TABLE.
      // FK enforcement is done via PRAGMA foreign_keys = ON (migration 018) which applies to
      // tables created with FK declarations. For existing tables, we enforce at application level.
      // A full schema rebuild would require copying all data — too risky for production.
    },
  },
  {
    id: '022_auth_and_billing',
    description: 'Add password_hash and billing columns to clients for JWT auth + Stripe',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      const addCol = (name, type) => {
        if (!cols.includes(name)) {
          db.exec(`ALTER TABLE clients ADD COLUMN ${name} ${type}`);
        }
      };
      addCol('password_hash', 'TEXT');
      addCol('plan', "TEXT DEFAULT 'trial'");
      addCol('subscription_status', "TEXT DEFAULT 'active'");
      addCol('stripe_customer_id', 'TEXT');
      addCol('stripe_subscription_id', 'TEXT');
      addCol('plan_started_at', 'TEXT');
      addCol('onboarding_completed', "INTEGER DEFAULT 0");
      addCol('onboarding_step', "INTEGER DEFAULT 0");

      // Index for email lookup (login)
      db.exec('CREATE INDEX IF NOT EXISTS idx_clients_owner_email ON clients(owner_email)');
      // Index for Stripe customer lookup
      db.exec('CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer ON clients(stripe_customer_id)');
    },
  },
];

/**
 * Run all pending migrations.
 * @param {object} db - better-sqlite3 instance
 * @returns {{ applied: string[], skipped: string[] }}
 */
function runMigrations(db) {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = db.prepare('SELECT id FROM _migrations').all().map(r => r.id);
  const newlyApplied = [];
  const skipped = [];

  const runAll = db.transaction(() => {
    for (const migration of migrations) {
      if (applied.includes(migration.id)) {
        skipped.push(migration.id);
        continue;
      }
      try {
        migration.up(db);
        db.prepare('INSERT INTO _migrations (id, description) VALUES (?, ?)').run(
          migration.id,
          migration.description
        );
        newlyApplied.push(migration.id);
        console.log(`[migrations] Applied: ${migration.id} — ${migration.description}`);
      } catch (err) {
        console.error(`[migrations] Failed: ${migration.id} — ${err.message}`);
        throw err; // Abort transaction
      }
    }
  });

  runAll();

  if (newlyApplied.length) {
    console.log(`[migrations] ${newlyApplied.length} new migration(s) applied`);
  } else {
    console.log('[migrations] Database is up to date');
  }

  return { applied: newlyApplied, skipped };
}

module.exports = { runMigrations, migrations };
