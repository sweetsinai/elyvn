/**
 * SQLite Migration Framework
 * Tracks applied migrations in a `_migrations` table.
 * Each migration is a function that receives the db instance.
 */

// Lazy-load logger — migrations run during db init when logger is already available
function getLogger() {
  try { return require('./logger').logger; }
  catch { return {
    info: (m) => process.stdout.write(JSON.stringify({ level: 'info', message: String(m) }) + '\n'),
    error: (m) => process.stderr.write(JSON.stringify({ level: 'error', message: String(m) }) + '\n'),
    warn: (m) => process.stderr.write(JSON.stringify({ level: 'warn', message: String(m) }) + '\n'),
    debug: () => {},
  }; }
}

const migrations = [
  {
    id: '001_base_tables',
    description: 'Ensure core tables exist (clients, calls, leads, messages, followups)',
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
    up(db) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_emails_sent_to_email ON emails_sent(to_email)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_emails_sent_reply ON emails_sent(reply_text, reply_classification)');
    },
  },
  {
    id: '010_email_tracking_columns',
    description: 'Add email tracking columns (opens, clicks, variants)',
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
    up(db) {
      // Use IF NOT EXISTS to be idempotent
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone_unique ON leads(client_id, phone)');
    },
  },
  {
    id: '012_client_api_keys',
    description: 'Create per-client API key authentication table',
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
    up(db) {
      const clientCols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!clientCols.includes('transfer_phone')) {
        db.exec('ALTER TABLE clients ADD COLUMN transfer_phone TEXT');
      }
    },
  },
  {
    id: '020_telnyx_phone_column',
    description: 'Add telnyx_phone to clients for Legacy SMS SMS provider migration',
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
    down(db) { /* safe to skip — data predates rollback support */ },
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
  {
    id: '023_notification_mode',
    description: 'Add notification_mode to clients (all or digest)',
    down(db) { /* safe to skip — data predates rollback support */ },
    up(db) {
      const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!cols.includes('notification_mode')) {
        db.exec("ALTER TABLE clients ADD COLUMN notification_mode TEXT DEFAULT 'all'");
      }
    },
  },
  {
    id: '024_calls_analysis_data',
    description: 'Add analysis_data column to calls table for storing call analysis JSON',
    down(db) { /* safe to skip — data predates rollback support */ },
    up(db) {
      const cols = db.prepare("PRAGMA table_info('calls')").all().map(c => c.name);
      if (!cols.includes('analysis_data')) {
        db.exec('ALTER TABLE calls ADD COLUMN analysis_data TEXT');
      }
    },
  },
  {
    id: '025_missing_indexes',
    description: 'Add indexes for frequently queried columns',
    down(db) { /* safe to skip — data predates rollback support */ },
    up(db) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_appointments_calcom_booking ON appointments(calcom_booking_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_leads_calcom_booking ON leads(calcom_booking_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_clients_twilio_phone ON clients(twilio_phone)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_clients_retell_phone ON clients(retell_phone)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_clients_retell_agent ON clients(retell_agent_id)");
    },
  },
  {
    id: '026_foreign_key_rebuild',
    description: 'Rebuild legacy tables with proper foreign key constraints',
    down(db) {
      // Restore tables to pre-026 schema (without FK constraints, nullable client_id)
      function rebuildTable(tableName, createSQL, indexes) {
        const newName = tableName + '_rollback';
        db.exec(`DROP TABLE IF EXISTS ${newName}`);
        db.exec(createSQL);
        const oldCols = db.prepare(`PRAGMA table_info('${tableName}')`).all().map(c => c.name);
        const newCols = db.prepare(`PRAGMA table_info('${newName}')`).all().map(c => c.name);
        const common = newCols.filter(c => oldCols.includes(c));
        const colList = common.join(', ');
        db.exec(`INSERT OR IGNORE INTO ${newName} (${colList}) SELECT ${colList} FROM ${tableName}`);
        db.exec(`DROP TABLE ${tableName}`);
        db.exec(`ALTER TABLE ${newName} RENAME TO ${tableName}`);
        for (const idx of indexes) db.exec(idx);
      }

      rebuildTable('calls', `
        CREATE TABLE calls_rollback (
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
          created_at TEXT DEFAULT (datetime('now')),
          score INTEGER,
          outcome TEXT,
          analysis_data TEXT
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_calls_call_id ON calls(call_id)',
        'CREATE INDEX IF NOT EXISTS idx_calls_caller_phone ON calls(caller_phone)',
        'CREATE INDEX IF NOT EXISTS idx_calls_client_id ON calls(client_id)',
        'CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(client_id, created_at)',
      ]);

      rebuildTable('leads', `
        CREATE TABLE leads_rollback (
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
          updated_at TEXT DEFAULT (datetime('now')),
          prospect_id TEXT,
          last_contact TEXT,
          calcom_booking_id TEXT
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_id, phone)',
        'CREATE INDEX IF NOT EXISTS idx_leads_prospect_id ON leads(prospect_id)',
        'CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)',
        'CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(client_id, stage)',
        'CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(client_id, score)',
        'CREATE INDEX IF NOT EXISTS idx_leads_client_created_at ON leads(client_id, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_leads_calcom_booking ON leads(calcom_booking_id)',
      ]);

      rebuildTable('messages', `
        CREATE TABLE messages_rollback (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          phone TEXT,
          direction TEXT,
          body TEXT,
          status TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          lead_id TEXT,
          channel TEXT DEFAULT 'sms',
          reply_text TEXT,
          reply_source TEXT,
          confidence REAL,
          updated_at TEXT DEFAULT (datetime('now')),
          message_sid TEXT
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_messages_client_phone ON messages(client_id, phone)',
        'CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(client_id, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_messages_phone_created_at ON messages(phone, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(message_sid)',
        'CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id)',
      ]);

      rebuildTable('followups', `
        CREATE TABLE followups_rollback (
          id TEXT PRIMARY KEY,
          lead_id TEXT,
          client_id TEXT,
          type TEXT,
          scheduled_at TEXT,
          completed_at TEXT,
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          touch_number INTEGER,
          content TEXT,
          content_source TEXT,
          sent_at TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_followups_lead_id ON followups(lead_id)',
        'CREATE INDEX IF NOT EXISTS idx_followups_client_id ON followups(client_id)',
        'CREATE INDEX IF NOT EXISTS idx_followups_status_scheduled ON followups(status, scheduled_at)',
      ]);

      rebuildTable('appointments', `
        CREATE TABLE appointments_rollback (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          lead_id TEXT,
          phone TEXT,
          name TEXT,
          service TEXT,
          datetime TEXT,
          status TEXT DEFAULT 'confirmed',
          calcom_booking_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_appointments_client_status ON appointments(client_id, status)',
        'CREATE INDEX IF NOT EXISTS idx_appointments_lead_id ON appointments(lead_id)',
        'CREATE INDEX IF NOT EXISTS idx_appointments_calcom_booking ON appointments(calcom_booking_id)',
      ]);
    },
    up(db) {
      // Helper: rebuild a table with a new schema, copying only columns that exist
      // in both old and new tables. Handles column mismatches between environments.
      function rebuildTable(tableName, createSQL, indexes, filter) {
        const newName = tableName + '_new';
        db.exec(`DROP TABLE IF EXISTS ${newName}`);
        db.exec(createSQL);
        const oldCols = db.prepare(`PRAGMA table_info('${tableName}')`).all().map(c => c.name);
        const newCols = db.prepare(`PRAGMA table_info('${newName}')`).all().map(c => c.name);
        const common = newCols.filter(c => oldCols.includes(c));
        const colList = common.join(', ');
        const where = filter ? ` WHERE ${filter}` : '';
        db.exec(`INSERT OR IGNORE INTO ${newName} (${colList}) SELECT ${colList} FROM ${tableName}${where}`);
        db.exec(`DROP TABLE ${tableName}`);
        db.exec(`ALTER TABLE ${newName} RENAME TO ${tableName}`);
        for (const idx of indexes) db.exec(idx);
      }

      // --- calls ---
      rebuildTable('calls', `
        CREATE TABLE calls_new (
          id TEXT PRIMARY KEY,
          call_id TEXT UNIQUE,
          client_id TEXT NOT NULL,
          caller_phone TEXT,
          direction TEXT DEFAULT 'inbound',
          status TEXT,
          duration INTEGER,
          recording_url TEXT,
          transcript TEXT,
          summary TEXT,
          sentiment TEXT,
          action_taken TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          score INTEGER,
          outcome TEXT,
          analysis_data TEXT
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_calls_call_id ON calls(call_id)',
        'CREATE INDEX IF NOT EXISTS idx_calls_caller_phone ON calls(caller_phone)',
        'CREATE INDEX IF NOT EXISTS idx_calls_client_id ON calls(client_id)',
        'CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(client_id, created_at)',
      ], null);

      // --- leads ---
      rebuildTable('leads', `
        CREATE TABLE leads_new (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          name TEXT,
          phone TEXT,
          email TEXT,
          source TEXT,
          score INTEGER DEFAULT 0,
          stage TEXT DEFAULT 'new',
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          prospect_id TEXT,
          last_contact TEXT,
          calcom_booking_id TEXT
        )`, [
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_id, phone)',
        'CREATE INDEX IF NOT EXISTS idx_leads_prospect_id ON leads(prospect_id)',
        'CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)',
        'CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(client_id, stage)',
        'CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(client_id, score)',
        'CREATE INDEX IF NOT EXISTS idx_leads_client_created_at ON leads(client_id, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_leads_calcom_booking ON leads(calcom_booking_id)',
      ], 'client_id IS NOT NULL');

      // --- messages ---
      rebuildTable('messages', `
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          phone TEXT,
          direction TEXT,
          body TEXT,
          status TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          lead_id TEXT,
          channel TEXT DEFAULT 'sms',
          reply_text TEXT,
          reply_source TEXT,
          confidence REAL,
          updated_at TEXT DEFAULT (datetime('now')),
          message_sid TEXT
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_messages_client_phone ON messages(client_id, phone)',
        'CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(client_id, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_messages_phone_created_at ON messages(phone, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(message_sid)',
        'CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id)',
      ], 'client_id IS NOT NULL');

      // --- followups ---
      rebuildTable('followups', `
        CREATE TABLE followups_new (
          id TEXT PRIMARY KEY,
          lead_id TEXT,
          client_id TEXT NOT NULL,
          type TEXT,
          scheduled_at TEXT,
          completed_at TEXT,
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          touch_number INTEGER,
          content TEXT,
          content_source TEXT,
          sent_at TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_followups_lead_id ON followups(lead_id)',
        'CREATE INDEX IF NOT EXISTS idx_followups_client_id ON followups(client_id)',
        'CREATE INDEX IF NOT EXISTS idx_followups_status_scheduled ON followups(status, scheduled_at)',
      ], 'client_id IS NOT NULL');

      // --- appointments ---
      rebuildTable('appointments', `
        CREATE TABLE appointments_new (
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
        )`, [
        'CREATE INDEX IF NOT EXISTS idx_appointments_client_status ON appointments(client_id, status)',
        'CREATE INDEX IF NOT EXISTS idx_appointments_lead_id ON appointments(lead_id)',
        'CREATE INDEX IF NOT EXISTS idx_appointments_calcom_booking ON appointments(calcom_booking_id)',
      ], 'client_id IS NOT NULL');
    },
  },
  {
    id: '027_drop_duplicate_leads_index',
    description: 'Remove duplicate unique index idx_leads_client_phone_unique (identical to idx_leads_client_phone)',
    down(db) {
      // Restore the duplicate unique index that was dropped
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone_unique ON leads(client_id, phone)');
    },
    up(db) {
      db.exec('DROP INDEX IF EXISTS idx_leads_client_phone_unique');
    },
  },
  {
    id: '028_reliability_fixes',
    description: 'Add attempts tracking to followups, ensure job_queue index exists',
    down(db) {
      // SQLite cannot drop columns — attempts column stays; drop the partial index
      db.exec('DROP INDEX IF EXISTS idx_job_queue_status_scheduled');
      // Restore the non-partial index from migration 004
      db.exec('CREATE INDEX IF NOT EXISTS idx_job_queue_status_scheduled ON job_queue(status, scheduled_at)');
    },
    up(db) {
      // Add attempts tracking to followups (used by appointmentReminders retry logic)
      // NOTE: FK cascade inconsistency exists across legacy tables — to be fixed in a future full schema rebuild.
      // Specifically: followups.lead_id and messages.lead_id use ON DELETE SET NULL in migration 026,
      // but several other join paths lack cascade rules. Do not patch piecemeal — plan a full rebuild.
      try {
        db.exec("ALTER TABLE followups ADD COLUMN attempts INTEGER DEFAULT 0");
      } catch (e) { /* column may already exist */ }

      // Ensure job_queue has index on status+scheduled_at for efficient polling
      db.exec(`CREATE INDEX IF NOT EXISTS idx_job_queue_status_scheduled
               ON job_queue(status, scheduled_at) WHERE status = 'pending'`);

      getLogger().info('[migrations] 028: reliability fixes applied');
    }
  },
  {
    id: '029_email_verification',
    description: 'Add email verification columns to clients table',
    down(db) {
      // SQLite cannot drop columns — drop the index; columns remain harmlessly
      db.exec('DROP INDEX IF EXISTS idx_clients_verification_token');
    },
    up(db) {
      const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!cols.includes('email_verified')) {
        db.exec('ALTER TABLE clients ADD COLUMN email_verified INTEGER DEFAULT 0');
      }
      if (!cols.includes('verification_token')) {
        db.exec('ALTER TABLE clients ADD COLUMN verification_token TEXT');
      }
      if (!cols.includes('verification_expires')) {
        db.exec('ALTER TABLE clients ADD COLUMN verification_expires TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_clients_verification_token ON clients(verification_token)');
    },
  },
  {
    id: '030_composite_indexes',
    description: 'Add composite indexes for hot query paths: messages(lead_id,created_at), emails_sent(status,sent_at), jobs(status,job_type), leads(prospect_id)',
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_messages_lead_created');
      db.exec('DROP INDEX IF EXISTS idx_jobs_status_type');
      db.exec('DROP INDEX IF EXISTS idx_emails_sent_status_sent_at');
    },
    up(db) {
      // Composite index for messages queried by lead with date range ordering
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_lead_created ON messages(lead_id, created_at)');

      // leads(prospect_id) already exists as idx_leads_prospect_id (migration 008) — skip

      // Composite index for job_queue by status+job_type (job_queue uses "type" not "job_type")
      // Check column name used in job_queue
      const jqCols = db.prepare("PRAGMA table_info('job_queue')").all().map(c => c.name);
      if (jqCols.includes('type')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status_type ON job_queue(status, type)');
      }

      // Composite index for emails_sent by status+sent_at for funnel queries
      db.exec('CREATE INDEX IF NOT EXISTS idx_emails_sent_status_sent_at ON emails_sent(status, sent_at)');

      getLogger().info('[migrations] 030: composite indexes applied');
    },
  },
  {
    id: '031_event_store',
    description: 'Create event_store table for event sourcing / audit trail of domain events',
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_events_aggregate');
      db.exec('DROP INDEX IF EXISTS idx_events_client');
      db.exec('DROP INDEX IF EXISTS idx_events_type');
      db.exec('DROP TABLE IF EXISTS event_store');
    },
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_store (
          id TEXT PRIMARY KEY,
          aggregate_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL CHECK(aggregate_type IN ('lead','campaign','client','message')),
          event_type TEXT NOT NULL,
          event_data TEXT NOT NULL,
          client_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_events_aggregate ON event_store(aggregate_id, aggregate_type);
        CREATE INDEX IF NOT EXISTS idx_events_client ON event_store(client_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_type ON event_store(event_type, client_id);
      `);
      getLogger().info('[migrations] 031: event_store table created');
    },
  },
  {
    id: '032_audit_log_mutation_columns',
    description: 'Add old_values and new_values columns to audit_log for data mutation tracking',
    down(db) {
      // SQLite cannot drop columns — old_values and new_values remain harmlessly
    },
    up(db) {
      const cols = db.prepare("PRAGMA table_info('audit_log')").all().map(c => c.name);
      if (!cols.includes('old_values')) {
        db.exec('ALTER TABLE audit_log ADD COLUMN old_values TEXT');
      }
      if (!cols.includes('new_values')) {
        db.exec('ALTER TABLE audit_log ADD COLUMN new_values TEXT');
      }
      getLogger().info('[migrations] 032: audit_log mutation columns added');
    },
  },
  {
    id: '033_pii_encrypted_columns',
    description: 'Add encrypted PII columns for leads (phone, email) and messages (body)',
    down(db) {
      // SQLite cannot drop columns — encrypted columns remain harmlessly
    },
    up(db) {
      const leadCols = db.prepare("PRAGMA table_info('leads')").all().map(c => c.name);
      if (!leadCols.includes('phone_encrypted')) {
        db.exec('ALTER TABLE leads ADD COLUMN phone_encrypted TEXT');
      }
      if (!leadCols.includes('email_encrypted')) {
        db.exec('ALTER TABLE leads ADD COLUMN email_encrypted TEXT');
      }
      const msgCols = db.prepare("PRAGMA table_info('messages')").all().map(c => c.name);
      if (!msgCols.includes('body_encrypted')) {
        db.exec('ALTER TABLE messages ADD COLUMN body_encrypted TEXT');
      }
      getLogger().info('[migrations] 033: encrypted PII columns added (phone_encrypted, email_encrypted, body_encrypted)');
    },
  },
  {
    id: '034_feature_store',
    description: 'Create feature_store table for ML feature pipeline',
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_features_lead');
      db.exec('DROP TABLE IF EXISTS feature_store');
    },
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feature_store (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          feature_name TEXT NOT NULL,
          feature_value REAL,
          feature_version TEXT NOT NULL DEFAULT 'v1',
          computed_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(lead_id, feature_name, feature_version)
        );
        CREATE INDEX IF NOT EXISTS idx_features_lead ON feature_store(lead_id);
      `);
      getLogger().info('[migrations] 034: feature_store table created');
    },
  },
  {
    id: '035_experiments',
    description: 'Create experiments, experiment_assignments, and experiment_outcomes tables for A/B testing',
    down(db) {
      db.exec('DROP TABLE IF EXISTS experiment_outcomes');
      db.exec('DROP TABLE IF EXISTS experiment_assignments');
      db.exec('DROP TABLE IF EXISTS experiments');
    },
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS experiments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          variants TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS experiment_assignments (
          id TEXT PRIMARY KEY,
          experiment_id TEXT NOT NULL REFERENCES experiments(id),
          subject_id TEXT NOT NULL,
          variant_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(experiment_id, subject_id)
        );
        CREATE TABLE IF NOT EXISTS experiment_outcomes (
          id TEXT PRIMARY KEY,
          experiment_id TEXT NOT NULL REFERENCES experiments(id),
          subject_id TEXT NOT NULL,
          variant_id TEXT NOT NULL,
          outcome TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      getLogger().info('[migrations] 035: experiments tables created');
    },
  },
  {
    id: '036',
    description: 'performance indexes for leads, messages, calls ordering and lookup',
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_leads_client_updated_at');
      db.exec('DROP INDEX IF EXISTS idx_leads_client_score');
      db.exec('DROP INDEX IF EXISTS idx_messages_sid');
      // idx_calls_call_id existed pre-036 — leave it
      db.exec('DROP INDEX IF EXISTS idx_job_queue_status_scheduled');
      db.exec('DROP INDEX IF EXISTS idx_event_store_aggregate');
      db.exec('DROP INDEX IF EXISTS idx_feature_store_lead');
      // Restore the plain non-partial job_queue index from 004
      db.exec('CREATE INDEX IF NOT EXISTS idx_job_queue_status_scheduled ON job_queue(status, scheduled_at)');
    },
    up(db) {
      db.exec(`
        -- Leads: ORDER BY updated_at DESC (primary leads list API)
        CREATE INDEX IF NOT EXISTS idx_leads_client_updated_at ON leads(client_id, updated_at);
        -- Leads: ORDER BY score DESC (scoring queries)
        CREATE INDEX IF NOT EXISTS idx_leads_client_score ON leads(client_id, score);
        -- Messages: idempotency check on message_sid
        CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(message_sid) WHERE message_sid IS NOT NULL;
        -- Calls: lookup by call_id (retell webhook hot path)
        CREATE INDEX IF NOT EXISTS idx_calls_call_id ON calls(call_id);
        -- Job queue: priority-aware ordering (for future priority column migration)
        CREATE INDEX IF NOT EXISTS idx_job_queue_status_scheduled ON job_queue(status, scheduled_at);
        -- Event store: per-aggregate timeline queries
        CREATE INDEX IF NOT EXISTS idx_event_store_aggregate ON event_store(client_id, aggregate_id, created_at);
        -- Feature store: per-lead lookup
        CREATE INDEX IF NOT EXISTS idx_feature_store_lead ON feature_store(lead_id, computed_at);
      `);
      getLogger().info('[migrations] 036: performance indexes added');
    },
  },
  {
    id: '037',
    description: 'job_queue priority column for speed-to-lead fast path',
    down(db) {
      // SQLite cannot drop columns — drop the priority index; priority column stays harmlessly
      db.exec('DROP INDEX IF EXISTS idx_job_queue_priority');
    },
    up(db) {
      db.exec(`
        ALTER TABLE job_queue ADD COLUMN priority INTEGER DEFAULT 5;
        CREATE INDEX IF NOT EXISTS idx_job_queue_priority ON job_queue(status, priority DESC, scheduled_at ASC);
      `);
      getLogger().info('[migrations] 037: job_queue priority column added');
    },
  },
  {
    id: '038_revenue_tracking',
    description: 'Add revenue_closed and job_value columns to leads; add booking_webhook_url and whatsapp_phone to clients',
    down(db) {
      // SQLite cannot drop columns — drop the partial index; columns stay harmlessly
      db.exec('DROP INDEX IF EXISTS idx_leads_revenue');
    },
    up(db) {
      const leadCols = db.prepare("PRAGMA table_info('leads')").all().map(c => c.name);
      if (!leadCols.includes('revenue_closed')) {
        db.exec('ALTER TABLE leads ADD COLUMN revenue_closed REAL DEFAULT 0');
      }
      if (!leadCols.includes('job_value')) {
        db.exec('ALTER TABLE leads ADD COLUMN job_value REAL DEFAULT 0');
      }

      const clientCols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!clientCols.includes('booking_webhook_url')) {
        db.exec('ALTER TABLE clients ADD COLUMN booking_webhook_url TEXT');
      }
      if (!clientCols.includes('whatsapp_phone')) {
        db.exec('ALTER TABLE clients ADD COLUMN whatsapp_phone TEXT');
      }

      // Index for revenue reporting queries
      db.exec('CREATE INDEX IF NOT EXISTS idx_leads_revenue ON leads(client_id, revenue_closed) WHERE revenue_closed > 0');

      getLogger().info('[migrations] 038: revenue tracking columns added');
    },
  },
  {
    id: '039_product_completeness',
    description: 'Add columns for voice selection, usage metering, white-label, referrals, onboarding, social channels',
    down(db) {
      // Drop new tables created in this migration (in dependency order)
      db.exec('DROP TABLE IF EXISTS referrals');
      db.exec('DROP TABLE IF EXISTS usage_records');
      db.exec('DROP INDEX IF EXISTS idx_resellers_email');
      db.exec('DROP TABLE IF EXISTS resellers');
      // Drop indexes added in this migration
      db.exec('DROP INDEX IF EXISTS idx_clients_reseller');
      db.exec('DROP INDEX IF EXISTS idx_clients_referral_code');
      db.exec('DROP INDEX IF EXISTS idx_usage_client_month');
      // SQLite cannot drop columns added to clients — they stay harmlessly
    },
    up(db) {
      const clientCols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      const addCol = (name, type) => {
        if (!clientCols.includes(name)) db.exec(`ALTER TABLE clients ADD COLUMN ${name} ${type}`);
      };

      // Per-client voice selection
      addCol('retell_voice', "TEXT DEFAULT '11labs-Adrian'");
      addCol('retell_language', "TEXT DEFAULT 'en-US'");

      // Usage metering
      addCol('calls_this_month', 'INTEGER DEFAULT 0');
      addCol('sms_this_month', 'INTEGER DEFAULT 0');
      addCol('billing_cycle_start', 'TEXT');

      // White-label / reseller
      addCol('reseller_id', 'TEXT');
      addCol('white_label_brand', 'TEXT');
      addCol('white_label_domain', 'TEXT');

      // Referral program
      addCol('referral_code', 'TEXT');
      addCol('referred_by', 'TEXT');
      addCol('referral_credits', 'INTEGER DEFAULT 0');

      // Social channels
      addCol('facebook_page_token_encrypted', 'TEXT');
      addCol('facebook_page_id', 'TEXT');
      addCol('instagram_user_id', 'TEXT');
      addCol('instagram_access_token_encrypted', 'TEXT');

      // Indexes
      db.exec('CREATE INDEX IF NOT EXISTS idx_clients_reseller ON clients(reseller_id) WHERE reseller_id IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_referral_code ON clients(referral_code) WHERE referral_code IS NOT NULL');

      // Reseller table
      db.exec(`
        CREATE TABLE IF NOT EXISTS resellers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT,
          brand_name TEXT,
          brand_color TEXT DEFAULT '#00E5CC',
          brand_logo_url TEXT,
          custom_domain TEXT,
          wholesale_price_cents INTEGER DEFAULT 14900,
          commission_pct REAL DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          stripe_connect_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_resellers_email ON resellers(email);
      `);

      // Usage metering table (monthly snapshots)
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_records (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          month TEXT NOT NULL,
          calls_count INTEGER DEFAULT 0,
          sms_count INTEGER DEFAULT 0,
          ai_decisions_count INTEGER DEFAULT 0,
          emails_count INTEGER DEFAULT 0,
          overage_calls INTEGER DEFAULT 0,
          overage_charged_cents INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(client_id, month)
        );
        CREATE INDEX IF NOT EXISTS idx_usage_client_month ON usage_records(client_id, month);
      `);

      // Referral tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS referrals (
          id TEXT PRIMARY KEY,
          referrer_id TEXT NOT NULL REFERENCES clients(id),
          referred_id TEXT NOT NULL REFERENCES clients(id),
          status TEXT DEFAULT 'pending',
          credit_cents INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(referrer_id, referred_id)
        );
      `);

      getLogger().info('[migrations] 039: product completeness columns added');
    },
  },
  {
    id: '040_followups_touch_unique',
    description: 'Add unique constraint on followups(lead_id, touch_number) to prevent duplicate touch inserts',
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_followups_lead_touch_unique');
    },
    up(db) {
      try {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_followups_lead_touch_unique
          ON followups(lead_id, touch_number)
          WHERE touch_number IS NOT NULL;
        `);
      } catch (_) {
        // Index may already exist — skip
      }
      getLogger().info('[migrations] 040: followups unique touch index added');
    },
  },
  {
    id: '041_fix_leads_unique_index',
    description: 'Restore UNIQUE constraint on leads(client_id, phone) dropped by migration 026 rebuild',
    down(db) {
      // Restore non-unique index (pre-041 state — 026 had created a non-unique version)
      db.exec('DROP INDEX IF EXISTS idx_leads_client_phone');
      db.exec('CREATE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_id, phone)');
    },
    up(db) {
      try {
        // Drop the non-unique index created by 026 and recreate as UNIQUE
        db.exec('DROP INDEX IF EXISTS idx_leads_client_phone');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_id, phone)');
      } catch (_) {
        // May fail if duplicate rows exist — log but continue
      }
      getLogger().info('[migrations] 041: leads(client_id, phone) UNIQUE index restored');
    },
  },
  {
    id: '042_unified_phone_number',
    description: 'Add phone_number column to unify retell_phone + twilio_phone into a single field',
    down(db) {
      // SQLite cannot drop columns — phone_number stays harmlessly; drop index
      db.exec('DROP INDEX IF EXISTS idx_clients_phone_number');
    },
    up(db) {
      const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      if (!cols.includes('phone_number')) {
        db.exec('ALTER TABLE clients ADD COLUMN phone_number TEXT');
      }
      // Backfill: prefer twilio_phone (the one actually assigned at provisioning), fall back to retell_phone
      db.exec("UPDATE clients SET phone_number = COALESCE(twilio_phone, retell_phone) WHERE phone_number IS NULL");
      db.exec('CREATE INDEX IF NOT EXISTS idx_clients_phone_number ON clients(phone_number)');
      getLogger().info('[migrations] 042: unified phone_number column added and backfilled');
    },
  },
  {
    id: '043_webhook_event_columns',
    description: 'Add webhook URL columns for call, SMS, and stage-change outbound events',
    down(db) {
      // SQLite cannot drop columns — these stay harmlessly
    },
    up(db) {
      const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      const newCols = ['lead_webhook_url', 'call_webhook_url', 'sms_webhook_url', 'stage_change_webhook_url'];
      // booking_webhook_url already exists (migration 038)
      for (const col of newCols) {
        if (!cols.includes(col)) {
          db.exec(`ALTER TABLE clients ADD COLUMN ${col} TEXT`);
        }
      }
      getLogger().info('[migrations] 043: webhook event columns added (lead, call, sms, stage_change)');
    },
  },
  {
    id: '044_conversations_and_delivery_status',
    description: 'Create conversations table for unified messaging, add delivery_status to messages, backfill conversations from existing messages',
    down(db) {
      // Drop new indexes and table; leave columns on messages (SQLite can't drop them)
      db.exec('DROP INDEX IF EXISTS idx_conversations_client_last_msg');
      db.exec('DROP INDEX IF EXISTS idx_conversations_lead');
      db.exec('DROP INDEX IF EXISTS idx_conversations_phone');
      db.exec('DROP INDEX IF EXISTS idx_messages_conversation');
      db.exec('DROP TABLE IF EXISTS conversations');
    },
    up(db) {
      // 1. Create conversations table — one conversation per (client_id, lead_phone)
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          lead_id TEXT,
          lead_phone TEXT NOT NULL,
          lead_name TEXT,
          last_message_at TEXT,
          last_message_preview TEXT,
          unread_count INTEGER DEFAULT 0,
          status TEXT DEFAULT 'active' CHECK(status IN ('active','archived','spam')),
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_client_last_msg ON conversations(client_id, last_message_at DESC);
        CREATE INDEX IF NOT EXISTS idx_conversations_lead ON conversations(lead_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(client_id, lead_phone);
      `);

      // 2. Add conversation_id and delivery_status to messages
      const msgCols = db.prepare("PRAGMA table_info('messages')").all().map(c => c.name);
      if (!msgCols.includes('conversation_id')) {
        db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)');
      }
      if (!msgCols.includes('delivery_status')) {
        db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT DEFAULT 'sent'");
      }
      if (!msgCols.includes('delivered_at')) {
        db.exec('ALTER TABLE messages ADD COLUMN delivered_at TEXT');
      }
      if (!msgCols.includes('read_at')) {
        db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT');
      }

      // 3. Backfill: create conversations from existing messages grouped by (client_id, phone)
      const groups = db.prepare(`
        SELECT m.client_id, m.phone, l.id as lead_id, l.name as lead_name,
               MAX(m.created_at) as last_msg_at,
               (SELECT body FROM messages m2 WHERE m2.client_id = m.client_id AND m2.phone = m.phone ORDER BY m2.created_at DESC LIMIT 1) as preview
        FROM messages m
        LEFT JOIN leads l ON l.client_id = m.client_id AND l.phone = m.phone
        WHERE m.client_id IS NOT NULL AND m.phone IS NOT NULL
        GROUP BY m.client_id, m.phone
      `).all();

      const { randomUUID } = require('crypto');
      const insertConv = db.prepare(`
        INSERT OR IGNORE INTO conversations (id, client_id, lead_id, lead_phone, lead_name, last_message_at, last_message_preview)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const updateMsgs = db.prepare(`
        UPDATE messages SET conversation_id = ? WHERE client_id = ? AND phone = ? AND conversation_id IS NULL
      `);

      for (const g of groups) {
        const convId = randomUUID();
        const preview = g.preview ? g.preview.substring(0, 100) : null;
        insertConv.run(convId, g.client_id, g.lead_id, g.phone, g.lead_name, g.last_msg_at, preview);
        updateMsgs.run(convId, g.client_id, g.phone);
      }

      // 4. Set delivery_status for existing outbound messages
      db.exec("UPDATE messages SET delivery_status = 'sent' WHERE direction = 'outbound' AND delivery_status IS NULL");
      db.exec("UPDATE messages SET delivery_status = 'received' WHERE direction = 'inbound' AND delivery_status IS NULL");

      getLogger().info(`[migrations] 044: conversations table created, ${groups.length} conversations backfilled, delivery_status added`);
    },
  },

  // ─── 047: Add signup-related columns to clients ─────────────────────────
  {
    id: '047_signup_columns',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      const addCol = (name, type) => {
        if (!cols.includes(name)) {
          db.exec(`ALTER TABLE clients ADD COLUMN ${name} ${type}`);
        }
      };
      addCol('referral_code', 'TEXT');
      addCol('referred_by', 'TEXT');
      addCol('onboarding_step', 'INTEGER DEFAULT 0');
      addCol('onboarding_completed', 'INTEGER DEFAULT 0');
      addCol('email_verified', 'INTEGER DEFAULT 0');
      addCol('verification_token', 'TEXT');
      addCol('verification_expires', 'TEXT');
      addCol('password_hash', 'TEXT');

      // Create unique index on referral_code if it doesn't exist
      try {
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_referral_code ON clients(referral_code) WHERE referral_code IS NOT NULL");
      } catch (_) { /* index may already exist */ }

      // Backfill business_name from name where business_name is NULL (only if name column exists)
      if (cols.includes('name')) {
        db.exec("UPDATE clients SET business_name = name WHERE business_name IS NULL AND name IS NOT NULL");
      }

      getLogger().info('[migrations] 047: signup columns added to clients');
    },
    down() { /* SQLite cannot drop columns */ },
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
        getLogger().info(`[migrations] Applied: ${migration.id} — ${migration.description}`);
      } catch (err) {
        getLogger().error(`[migrations] Failed: ${migration.id} — ${err.message}`);
        throw err; // Abort transaction
      }
    }
  });

  runAll();

  if (newlyApplied.length) {
    getLogger().info(`[migrations] ${newlyApplied.length} new migration(s) applied`);
  } else {
    getLogger().info('[migrations] Database is up to date');
  }

  return { applied: newlyApplied, skipped };
}

/**
 * Roll back a specific migration by its id.
 * Runs the migration's down() function and removes it from _migrations so it
 * can be re-applied. Wraps everything in a transaction.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} migrationId - the migration id string (e.g. '041_fix_leads_unique_index')
 * @returns {{ success: boolean, id: string, error?: string }}
 */
function rollbackMigration(db, migrationId) {
  const migration = migrations.find(m => m.id === migrationId);
  if (!migration) {
    return { success: false, id: migrationId, error: `Migration '${migrationId}' not found` };
  }
  if (typeof migration.down !== 'function') {
    return { success: false, id: migrationId, error: `Migration '${migrationId}' has no down() function` };
  }

  const applied = db.prepare('SELECT id FROM _migrations WHERE id = ?').get(migrationId);
  if (!applied) {
    return { success: false, id: migrationId, error: `Migration '${migrationId}' is not currently applied` };
  }

  const rollback = db.transaction(() => {
    migration.down(db);
    db.prepare('DELETE FROM _migrations WHERE id = ?').run(migrationId);
  });

  try {
    rollback();
    getLogger().info(`[migrations] Rolled back: ${migrationId}`);
    return { success: true, id: migrationId };
  } catch (err) {
    getLogger().error(`[migrations] Rollback failed: ${migrationId} — ${err.message}`);
    return { success: false, id: migrationId, error: err.message };
  }
}

// ── 045: Stripe → Dodo Payments migration ──
migrations.push({
  id: '045_stripe_to_dodo',
  description: 'Add dodo_customer_id and dodo_subscription_id columns, backfill from Stripe columns',
  up(db) {
    const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);

    if (!cols.includes('dodo_customer_id')) {
      db.exec('ALTER TABLE clients ADD COLUMN dodo_customer_id TEXT');
    }
    if (!cols.includes('dodo_subscription_id')) {
      db.exec('ALTER TABLE clients ADD COLUMN dodo_subscription_id TEXT');
    }

    // Backfill: copy stripe IDs to dodo columns for any existing paying clients
    // (so billing status lookups work during transition)
    if (cols.includes('stripe_customer_id')) {
      db.exec(`
        UPDATE clients
        SET dodo_customer_id = stripe_customer_id
        WHERE stripe_customer_id IS NOT NULL AND dodo_customer_id IS NULL
      `);
    }
    if (cols.includes('stripe_subscription_id')) {
      db.exec(`
        UPDATE clients
        SET dodo_subscription_id = stripe_subscription_id
        WHERE stripe_subscription_id IS NOT NULL AND dodo_subscription_id IS NULL
      `);
    }

    // Index for webhook lookups by dodo customer ID
    db.exec('CREATE INDEX IF NOT EXISTS idx_clients_dodo_customer ON clients(dodo_customer_id)');
  },
  down(db) {
    // SQLite cannot drop columns — just drop the index
    db.exec('DROP INDEX IF EXISTS idx_clients_dodo_customer');
  },
});

// ── 046: Google Sheets integration — add google_sheet_id to clients ──
migrations.push({
  id: '046_google_sheet_id',
  description: 'Add google_sheet_id column to clients for native Google Sheets logging',
  up(db) {
    const cols = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
    if (!cols.includes('google_sheet_id')) {
      db.exec('ALTER TABLE clients ADD COLUMN google_sheet_id TEXT');
    }
  },
  down(db) {
    // SQLite cannot drop columns
  },
});

// ── 048: Clean up test data — remove old test clients ──
migrations.push({
  id: '048_cleanup_test_data',
  description: 'Remove old test clients and their data (WeBrakes, duplicate elyvn)',
  up(db) {
    const oldIds = [
      '1a72f414-375d-48f7-809d-b1ecc444cd91',
      'a11fca87-de51-4f4c-9151-4aee804e16ec',
    ];
    const tables = ['leads', 'calls', 'messages', 'followups', 'appointments', 'job_queue', 'emails_sent', 'prospects', 'campaigns', 'referrals', 'conversations'];
    for (const id of oldIds) {
      for (const t of tables) {
        try { db.prepare(`DELETE FROM ${t} WHERE client_id = ?`).run(id); } catch (_) {}
      }
      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    }
    getLogger().info('[migrations] 048: cleaned up test data');
  },
  down() { /* data deletion is irreversible */ },
});

// ── 049: Set password for provisioned ELYVN admin account ──
migrations.push({
  id: '049_set_admin_password',
  description: 'Set login password for the provisioned ELYVN admin client',
  up(db) {
    // Password: Elyvn2026 (scrypt N=16384, r=8, p=1)
    const hash = '3849d612f375a466e38c67ef5e61e85d:191543809136ca82520c01ce53a761f85a63e8c7b7002bfae8ee2e2d2f8435381759b7e540bfcb5d7da8193bc08fe3e1db94d7fdd3abdef25844bb8a0cf016d9';
    const result = db.prepare("UPDATE clients SET password_hash = ?, email_verified = 1 WHERE owner_email = 'ssohangowda@gmail.com'").run(hash);
    getLogger().info(`[migrations] 049: set admin password (${result.changes} rows)`);
  },
  down() {},
});

// ── 050: Add missing columns to calls + audit_log ──
migrations.push({
  id: '050_missing_columns',
  description: 'Add caller_name to calls, hash/previous_hash to audit_log',
  up(db) {
    const callCols = db.prepare("PRAGMA table_info('calls')").all().map(c => c.name);
    if (!callCols.includes('caller_name')) db.exec('ALTER TABLE calls ADD COLUMN caller_name TEXT');

    try {
      const auditCols = db.prepare("PRAGMA table_info('audit_log')").all().map(c => c.name);
      if (!auditCols.includes('hash')) db.exec('ALTER TABLE audit_log ADD COLUMN hash TEXT');
      if (!auditCols.includes('previous_hash')) db.exec('ALTER TABLE audit_log ADD COLUMN previous_hash TEXT');
    } catch (_) { /* audit_log may not exist yet */ }
  },
  down() {},
});

// ── 051: Add all missing columns to calls table ──
migrations.push({
  id: '051_calls_all_missing_columns',
  description: 'Add updated_at, caller_name, outcome, score, sentiment to calls if missing',
  up(db) {
    const cols = db.prepare("PRAGMA table_info('calls')").all().map(c => c.name);
    const add = (name, type) => {
      if (!cols.includes(name)) db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`);
    };
    add('updated_at', 'TEXT');
    add('caller_name', 'TEXT');
    add('outcome', 'TEXT');
    add('score', 'INTEGER');
    add('sentiment', 'TEXT');
  },
  down() {},
});

// ── 052: Add ALL missing columns referenced in code but absent from schema ──
migrations.push({
  id: '052_all_missing_columns',
  description: 'Add every column referenced in code but missing from DB: clients (timezone, auto_followup_enabled, kb_path, business_address, website, ai_enabled, booking_link, ticket_price), calls (twilio_call_sid), campaigns (client_id), emails_sent (client_id), job_queue (client_id), prospects (client_id)',
  up(db) {
    // Helper: add column if it doesn't already exist
    function addIfMissing(table, name, type) {
      const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map(c => c.name);
      if (!cols.includes(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }

    // ── clients table ──
    // timezone: INSERTed in clients.js, onboard.js, provision.js; SELECTed in settings.js
    addIfMissing('clients', 'timezone', "TEXT DEFAULT 'UTC'");
    // auto_followup_enabled: SELECTed in settings.js; in ALLOWED_CLIENT_FIELDS
    addIfMissing('clients', 'auto_followup_enabled', 'INTEGER DEFAULT 1');
    // kb_path: INSERTed in onboard.js
    addIfMissing('clients', 'kb_path', 'TEXT');
    // business_address: in ALLOWED_CLIENT_FIELDS (UPDATE crashes if sent)
    addIfMissing('clients', 'business_address', 'TEXT');
    // website: in ALLOWED_CLIENT_FIELDS (UPDATE crashes if sent)
    addIfMissing('clients', 'website', 'TEXT');
    // ai_enabled: in ALLOWED_CLIENT_FIELDS
    addIfMissing('clients', 'ai_enabled', 'INTEGER DEFAULT 1');
    // booking_link: in ALLOWED_CLIENT_FIELDS (separate from calcom_booking_link)
    addIfMissing('clients', 'booking_link', 'TEXT');
    // ticket_price: in ALLOWED_CLIENT_FIELDS (separate from avg_ticket)
    addIfMissing('clients', 'ticket_price', 'REAL');

    // ── calls table ──
    // twilio_call_sid: SELECTed in routes/api/calls.js:199 for cold transfer fallback
    addIfMissing('calls', 'twilio_call_sid', 'TEXT');

    // ── campaigns table ──
    // client_id: INSERTed in campaigns.js, SELECTed in email-send.js, WHERE in telegram/commands.js
    addIfMissing('campaigns', 'client_id', 'TEXT');

    // ── emails_sent table ──
    // client_id: SELECTed in email-send.js:20 for access control
    addIfMissing('emails_sent', 'client_id', 'TEXT');

    // ── job_queue table ──
    // client_id: Postgres schema has it; migration 048 cleanup references it
    addIfMissing('job_queue', 'client_id', 'TEXT');

    // ── prospects table ──
    // client_id: Postgres schema has it; migration 048 cleanup references it
    addIfMissing('prospects', 'client_id', 'TEXT');

    // ── Indexes for new columns ──
    db.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_client_id ON campaigns(client_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_emails_sent_client_id ON emails_sent(client_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_queue_client_id ON job_queue(client_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_prospects_client_id ON prospects(client_id)');

    getLogger().info('[migrations] 052: all missing columns added (13 columns across 5 tables)');
  },
  down() {
    // SQLite cannot drop columns — they remain harmlessly
  },
});

// ── 053: Add retell_llm_id ──
migrations.push({
  id: '053_add_retell_llm_id',
  description: 'Add retell_llm_id to clients table to track associated LLM directly',
  up(db) {
    const tableInfo = db.pragma('table_info(clients)');
    const hasCol = tableInfo.some(c => c.name === 'retell_llm_id');
    if (!hasCol) {
      db.exec('ALTER TABLE clients ADD COLUMN retell_llm_id TEXT');
      getLogger().info('[migrations] 053: Added retell_llm_id column to clients table');
    }
  },
  down() {
    // SQLite cannot drop columns
  },
});

migrations.push({
  id: '054_provisioning_logs',
  description: 'Create provisioning_logs table to track state of ongoing client provisioning',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provisioning_logs (
        id TEXT PRIMARY KEY,
        client_id TEXT,
        business_name TEXT,
        stage TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
        details TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_provisioning_logs_client ON provisioning_logs(client_id);
      CREATE INDEX IF NOT EXISTS idx_provisioning_logs_business ON provisioning_logs(business_name);
    `);
    getLogger().info('[migrations] 054: Created provisioning_logs table');
  },
  down(db) {
    db.exec('DROP TABLE IF EXISTS provisioning_logs');
  },
});

module.exports = { runMigrations, rollbackMigration, migrations };
