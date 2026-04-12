const Database = require('better-sqlite3');
const { migrations } = require('../utils/migrations');

describe('migrations', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should have migrations array', () => {
    expect(migrations).toBeDefined();
    expect(Array.isArray(migrations)).toBe(true);
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('should have migration 001_base_tables', () => {
    const migration = migrations.find(m => m.id === '001_base_tables');
    expect(migration).toBeDefined();
    expect(migration.description).toBeDefined();
    expect(typeof migration.up).toBe('function');
  });

  it('should have migration 002_appointments', () => {
    const migration = migrations.find(m => m.id === '002_appointments');
    expect(migration).toBeDefined();
  });

  it('should have migration 003_sms_opt_outs', () => {
    const migration = migrations.find(m => m.id === '003_sms_opt_outs');
    expect(migration).toBeDefined();
  });

  it('should have migration 004_job_queue', () => {
    const migration = migrations.find(m => m.id === '004_job_queue');
    expect(migration).toBeDefined();
  });

  it('should have migration 005_outreach_tables', () => {
    const migration = migrations.find(m => m.id === '005_outreach_tables');
    expect(migration).toBeDefined();
  });

  describe('migration 001_base_tables', () => {
    it('should create clients table', () => {
      const migration = migrations.find(m => m.id === '001_base_tables');
      migration.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clients'").get();
      expect(table).toBeDefined();
    });

    it('should create calls table', () => {
      const migration = migrations.find(m => m.id === '001_base_tables');
      migration.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calls'").get();
      expect(table).toBeDefined();
    });

    it('should create leads table', () => {
      const migration = migrations.find(m => m.id === '001_base_tables');
      migration.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'").get();
      expect(table).toBeDefined();
    });

    it('should create messages table', () => {
      const migration = migrations.find(m => m.id === '001_base_tables');
      migration.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
      expect(table).toBeDefined();
    });

    it('should create followups table', () => {
      const migration = migrations.find(m => m.id === '001_base_tables');
      migration.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='followups'").get();
      expect(table).toBeDefined();
    });
  });

  describe('migration 002_appointments', () => {
    it('should create appointments table', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m002 = migrations.find(m => m.id === '002_appointments');
      m001.up(db);
      m002.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='appointments'").get();
      expect(table).toBeDefined();

      const columns = db.prepare("PRAGMA table_info('appointments')").all();
      expect(columns.map(c => c.name)).toEqual(expect.arrayContaining([
        'id', 'client_id', 'lead_id', 'phone', 'name', 'service', 'datetime',
        'status', 'calcom_booking_id', 'created_at', 'updated_at'
      ]));
    });
  });

  describe('migration 003_sms_opt_outs', () => {
    it('should create sms_opt_outs table', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m003 = migrations.find(m => m.id === '003_sms_opt_outs');
      m001.up(db);
      m003.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sms_opt_outs'").get();
      expect(table).toBeDefined();

      const columns = db.prepare("PRAGMA table_info('sms_opt_outs')").all();
      expect(columns.map(c => c.name)).toEqual(expect.arrayContaining([
        'id', 'phone', 'client_id', 'opted_out_at', 'reason', 'created_at'
      ]));
    });

    it('should have unique constraint on phone and client_id', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m003 = migrations.find(m => m.id === '003_sms_opt_outs');
      m001.up(db);
      m003.up(db);

      db.prepare('INSERT INTO sms_opt_outs (id, phone, client_id) VALUES (?, ?, ?)').run('opt1', '+12125551234', 'client1');

      expect(() => {
        db.prepare('INSERT INTO sms_opt_outs (id, phone, client_id) VALUES (?, ?, ?)').run('opt2', '+12125551234', 'client1');
      }).toThrow();
    });
  });

  describe('migration 004_job_queue', () => {
    it('should create job_queue table', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m004 = migrations.find(m => m.id === '004_job_queue');
      m001.up(db);
      m004.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_queue'").get();
      expect(table).toBeDefined();

      const columns = db.prepare("PRAGMA table_info('job_queue')").all();
      expect(columns.map(c => c.name)).toEqual(expect.arrayContaining([
        'id', 'type', 'payload', 'scheduled_at', 'status', 'attempts',
        'max_attempts', 'created_at', 'updated_at'
      ]));
    });

    it('should create index on status and scheduled_at', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m004 = migrations.find(m => m.id === '004_job_queue');
      m001.up(db);
      m004.up(db);

      const index = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_job_queue_status_scheduled'"
      ).get();
      expect(index).toBeDefined();
    });
  });

  describe('migration 005_outreach_tables', () => {
    it('should create prospects table', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m005 = migrations.find(m => m.id === '005_outreach_tables');
      m001.up(db);
      m005.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prospects'").get();
      expect(table).toBeDefined();
    });

    it('should create campaigns table', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m005 = migrations.find(m => m.id === '005_outreach_tables');
      m001.up(db);
      m005.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
      expect(table).toBeDefined();
    });

    it('should create emails_sent table', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m005 = migrations.find(m => m.id === '005_outreach_tables');
      m001.up(db);
      m005.up(db);

      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails_sent'").get();
      expect(table).toBeDefined();
    });
  });

  describe('migration 006_indexes', () => {
    it('should create performance indexes', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m005 = migrations.find(m => m.id === '005_outreach_tables');
      const m006 = migrations.find(m => m.id === '006_indexes');
      m001.up(db);
      m005.up(db);
      m006.up(db);

      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
      ).all();

      expect(indexes.length).toBeGreaterThanOrEqual(5);
    });

    it('should have index on calls.caller_phone', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m005 = migrations.find(m => m.id === '005_outreach_tables');
      const m006 = migrations.find(m => m.id === '006_indexes');
      m001.up(db);
      m005.up(db);
      m006.up(db);

      const index = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_calls_caller_phone'"
      ).get();
      expect(index).toBeDefined();
    });
  });

  describe('migration 007_client_columns', () => {
    it('should add google_review_link and business_hours columns to clients', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m007 = migrations.find(m => m.id === '007_client_columns');
      m001.up(db);
      m007.up(db);

      const columns = db.prepare("PRAGMA table_info('clients')").all().map(c => c.name);
      expect(columns).toContain('google_review_link');
      expect(columns).toContain('business_hours');
    });
  });

  describe('migration 008_leads_prospect_id', () => {
    it('should add prospect_id and related columns to leads', () => {
      const m001 = migrations.find(m => m.id === '001_base_tables');
      const m008 = migrations.find(m => m.id === '008_leads_prospect_id');
      m001.up(db);
      m008.up(db);

      const columns = db.prepare("PRAGMA table_info('leads')").all().map(c => c.name);
      expect(columns).toContain('prospect_id');
      expect(columns).toContain('last_contact');
      expect(columns).toContain('calcom_booking_id');
    });
  });
});
