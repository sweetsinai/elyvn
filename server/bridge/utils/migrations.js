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
          status TEXT DEFAULT 'new',
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
