-- ============================================================
-- Elyvn — Initial PostgreSQL Schema (Supabase)
-- Equivalent of SQLite migrations 001–029
-- ============================================================
-- Conventions:
--   • UUID primary keys via gen_random_uuid()
--   • TIMESTAMPTZ for all timestamps
--   • Foreign keys with ON DELETE CASCADE (or SET NULL where appropriate)
--   • Row-Level Security (RLS) policies for multi-tenant isolation
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- uuid_generate_v4() (alias)

-- ============================================================
-- TABLE: clients
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  industry                TEXT,
  owner_name              TEXT,
  owner_phone             TEXT,
  owner_email             TEXT,
  twilio_phone            TEXT,
  telnyx_phone            TEXT,
  transfer_phone          TEXT,
  retell_agent_id         TEXT,
  retell_phone            TEXT,
  phone_number            TEXT,
  knowledge_base          TEXT,
  google_review_link      TEXT,
  business_hours          TEXT,
  telegram_chat_id        TEXT,
  calcom_booking_link     TEXT,
  calcom_event_type_id    TEXT,
  business_name           TEXT,
  avg_ticket              NUMERIC(10, 2) DEFAULT 0,
  is_active               BOOLEAN DEFAULT TRUE,
  password_hash           TEXT,
  plan                    TEXT DEFAULT 'trial',
  subscription_status     TEXT DEFAULT 'active',
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  plan_started_at         TIMESTAMPTZ,
  onboarding_completed    BOOLEAN DEFAULT FALSE,
  onboarding_step         INTEGER DEFAULT 0,
  notification_mode       TEXT DEFAULT 'all',
  email_verified          BOOLEAN DEFAULT FALSE,
  verification_token      TEXT,
  verification_expires    TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_owner_email        ON clients(owner_email);
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer    ON clients(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_clients_twilio_phone       ON clients(twilio_phone);
CREATE INDEX IF NOT EXISTS idx_clients_telnyx_phone       ON clients(telnyx_phone);
CREATE INDEX IF NOT EXISTS idx_clients_retell_phone       ON clients(retell_phone);
CREATE INDEX IF NOT EXISTS idx_clients_retell_agent       ON clients(retell_agent_id);
CREATE INDEX IF NOT EXISTS idx_clients_phone_number       ON clients(phone_number);
CREATE INDEX IF NOT EXISTS idx_clients_verification_token ON clients(verification_token);

-- ============================================================
-- TABLE: calls
-- ============================================================
CREATE TABLE IF NOT EXISTS calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       TEXT UNIQUE,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  caller_phone  TEXT,
  direction     TEXT DEFAULT 'inbound',
  status        TEXT,
  duration      INTEGER,
  recording_url TEXT,
  transcript    TEXT,
  summary       TEXT,
  sentiment     TEXT,
  action_taken  TEXT,
  score         INTEGER,
  outcome       TEXT,
  analysis_data JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_call_id          ON calls(call_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller_phone     ON calls(caller_phone);
CREATE INDEX IF NOT EXISTS idx_calls_client_id        ON calls(client_id);
CREATE INDEX IF NOT EXISTS idx_calls_client_created   ON calls(client_id, created_at);

-- ============================================================
-- TABLE: leads
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name              TEXT,
  phone             TEXT,
  email             TEXT,
  source            TEXT,
  score             INTEGER DEFAULT 0,
  stage             TEXT DEFAULT 'new',
  notes             TEXT,
  prospect_id       UUID,                         -- references prospects(id), nullable FK
  last_contact      TIMESTAMPTZ,
  calcom_booking_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_leads_prospect_id     ON leads(prospect_id);
CREATE INDEX IF NOT EXISTS idx_leads_email           ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_client_stage    ON leads(client_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_client_score    ON leads(client_id, score);
CREATE INDEX IF NOT EXISTS idx_leads_client_created  ON leads(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_calcom_booking  ON leads(calcom_booking_id);

-- ============================================================
-- TABLE: messages
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id       UUID REFERENCES leads(id) ON DELETE SET NULL,
  phone         TEXT,
  direction     TEXT,
  body          TEXT,
  status        TEXT,
  channel       TEXT DEFAULT 'sms',
  reply_text    TEXT,
  reply_source  TEXT,
  confidence    NUMERIC(5, 4),
  message_sid   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_client_phone    ON messages(client_id, phone);
CREATE INDEX IF NOT EXISTS idx_messages_client_created  ON messages(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_phone_created   ON messages(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_lead_id         ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_sid             ON messages(message_sid);
CREATE INDEX IF NOT EXISTS idx_messages_lead_created    ON messages(lead_id, created_at);

-- ============================================================
-- TABLE: followups
-- ============================================================
CREATE TABLE IF NOT EXISTS followups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type            TEXT,
  scheduled_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  status          TEXT DEFAULT 'pending',
  notes           TEXT,
  touch_number    INTEGER,
  content         TEXT,
  content_source  TEXT,
  attempts        INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followups_lead_id          ON followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_client_id        ON followups(client_id);
CREATE INDEX IF NOT EXISTS idx_followups_status_scheduled ON followups(status, scheduled_at);

-- ============================================================
-- TABLE: appointments
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
  phone               TEXT,
  name                TEXT,
  service             TEXT,
  datetime            TIMESTAMPTZ,
  status              TEXT DEFAULT 'confirmed',
  calcom_booking_id   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_client_status  ON appointments(client_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_lead_id        ON appointments(lead_id);
CREATE INDEX IF NOT EXISTS idx_appointments_calcom_booking ON appointments(calcom_booking_id);

-- ============================================================
-- TABLE: sms_opt_outs
-- ============================================================
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL,
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  opted_out_at TIMESTAMPTZ DEFAULT NOW(),
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phone, client_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_opt_outs_client_id ON sms_opt_outs(client_id);

-- ============================================================
-- TABLE: job_queue
-- ============================================================
CREATE TABLE IF NOT EXISTS job_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID REFERENCES clients(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,
  payload      JSONB,
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at    TIMESTAMPTZ,
  error        TEXT,
  attempts     INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  status       TEXT DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_queue_client_id ON job_queue(client_id);

CREATE INDEX IF NOT EXISTS idx_job_queue_status_scheduled ON job_queue(status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_jobs_status_type ON job_queue(status, type);

-- ============================================================
-- TABLE: prospects
-- ============================================================
CREATE TABLE IF NOT EXISTS prospects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
  business_name TEXT,
  phone         TEXT,
  email         TEXT,
  website       TEXT,
  address       TEXT,
  industry      TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT DEFAULT 'US',
  rating        NUMERIC(3, 1),
  review_count  INTEGER,
  hours         TEXT,
  status        TEXT DEFAULT 'scraped',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospects_client_id ON prospects(client_id);

CREATE INDEX IF NOT EXISTS idx_prospects_status       ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_city_industry ON prospects(city, industry);

-- Back-fill FK from leads.prospect_id now that prospects table exists
ALTER TABLE leads
  ADD CONSTRAINT fk_leads_prospect_id
  FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE SET NULL
  NOT VALID;   -- NOT VALID skips scan of existing rows; validate separately if needed

-- ============================================================
-- TABLE: campaigns
-- ============================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID REFERENCES clients(id) ON DELETE CASCADE,
  name             TEXT,
  industry         TEXT,
  city             TEXT,
  total_prospects  INTEGER DEFAULT 0,
  total_sent       INTEGER DEFAULT 0,
  total_replied    INTEGER DEFAULT 0,
  total_positive   INTEGER DEFAULT 0,
  total_booked     INTEGER DEFAULT 0,
  status           TEXT DEFAULT 'draft',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_client_id ON campaigns(client_id);

-- ============================================================
-- TABLE: campaign_prospects
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_prospects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id  UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, prospect_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_prospects_campaign  ON campaign_prospects(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_prospects_prospect  ON campaign_prospects(prospect_id);

-- ============================================================
-- TABLE: emails_sent
-- ============================================================
CREATE TABLE IF NOT EXISTS emails_sent (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID REFERENCES clients(id) ON DELETE SET NULL,
  campaign_id           UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  prospect_id           UUID REFERENCES prospects(id) ON DELETE CASCADE,
  to_email              TEXT,
  from_email            TEXT,
  subject               TEXT,
  body                  TEXT,
  sent_at               TIMESTAMPTZ,
  status                TEXT DEFAULT 'draft',
  reply_text            TEXT,
  reply_classification  TEXT,
  reply_at              TIMESTAMPTZ,
  auto_response_sent    BOOLEAN DEFAULT FALSE,
  error                 TEXT,
  opened_at             TIMESTAMPTZ,
  open_count            INTEGER DEFAULT 0,
  clicked_at            TIMESTAMPTZ,
  click_count           INTEGER DEFAULT 0,
  variant               TEXT,
  subject_a             TEXT,
  subject_b             TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (prospect_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_emails_sent_client_id ON emails_sent(client_id);

CREATE INDEX IF NOT EXISTS idx_emails_sent_status             ON emails_sent(status);
CREATE INDEX IF NOT EXISTS idx_emails_sent_prospect           ON emails_sent(prospect_id);
CREATE INDEX IF NOT EXISTS idx_emails_sent_campaign_status    ON emails_sent(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_emails_sent_to_email           ON emails_sent(to_email);
CREATE INDEX IF NOT EXISTS idx_emails_sent_reply              ON emails_sent(reply_text, reply_classification);
CREATE INDEX IF NOT EXISTS idx_emails_sent_status_sent_at     ON emails_sent(status, sent_at);

-- ============================================================
-- TABLE: client_api_keys
-- ============================================================
CREATE TABLE IF NOT EXISTS client_api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  api_key_hash TEXT NOT NULL,
  label        TEXT DEFAULT 'default',
  permissions  JSONB DEFAULT '["read","write"]'::jsonb,
  rate_limit   INTEGER DEFAULT 120,
  is_active    BOOLEAN DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_api_keys_hash   ON client_api_keys(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_client_api_keys_client ON client_api_keys(client_id);

-- ============================================================
-- TABLE: audit_log
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
  user_id       TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  details       JSONB,
  old_values    TEXT,
  new_values    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_client  ON audit_log(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON audit_log(action, created_at);

-- ============================================================
-- TABLE: weekly_reports
-- ============================================================
CREATE TABLE IF NOT EXISTS weekly_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start           DATE NOT NULL,
  week_end             DATE NOT NULL,
  calls_answered       INTEGER DEFAULT 0,
  appointments_booked  INTEGER DEFAULT 0,
  messages_handled     INTEGER DEFAULT 0,
  estimated_revenue    NUMERIC(12, 2) DEFAULT 0,
  missed_call_rate     NUMERIC(5, 4) DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_client_week ON weekly_reports(client_id, week_end);

-- ============================================================
-- TABLE: data_retention_policy
-- ============================================================
CREATE TABLE IF NOT EXISTS data_retention_policy (
  id             SERIAL PRIMARY KEY,
  table_name     TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL DEFAULT 365,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO data_retention_policy (table_name, retention_days) VALUES
  ('messages',    90),
  ('calls',       365),
  ('emails_sent', 180),
  ('audit_log',   180),
  ('job_queue',   30)
ON CONFLICT (table_name) DO NOTHING;

-- ============================================================
-- ADDITIONAL TABLES (from SQLite migrations 031–035)
-- ============================================================

-- TABLE: event_store — domain event sourcing / audit trail
CREATE TABLE IF NOT EXISTS event_store (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id    TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL CHECK(aggregate_type IN ('lead','campaign','client','message')),
  event_type      TEXT NOT NULL,
  event_data      JSONB NOT NULL,
  client_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_events_aggregate ON event_store(aggregate_id, aggregate_type);
CREATE INDEX IF NOT EXISTS idx_events_client    ON event_store(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type      ON event_store(event_type, client_id);

-- TABLE: feature_store — ML feature pipeline
CREATE TABLE IF NOT EXISTS feature_store (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  feature_name    TEXT NOT NULL,
  feature_value   NUMERIC,
  feature_version TEXT NOT NULL DEFAULT 'v1',
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lead_id, feature_name, feature_version)
);

CREATE INDEX IF NOT EXISTS idx_features_lead ON feature_store(lead_id);

-- TABLE: experiments — A/B testing framework
CREATE TABLE IF NOT EXISTS experiments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
  name        TEXT NOT NULL UNIQUE,
  variants    JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experiments_client_id ON experiments(client_id);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  client_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
  subject_id      TEXT NOT NULL,
  variant_id      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(experiment_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_experiment_assignments_client_id ON experiment_assignments(client_id);

CREATE TABLE IF NOT EXISTS experiment_outcomes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  client_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
  subject_id      TEXT NOT NULL,
  variant_id      TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experiment_outcomes_client_id ON experiment_outcomes(client_id);

-- ============================================================
-- Encrypted PII columns (migration 033 equivalent)
-- ============================================================
ALTER TABLE leads    ADD COLUMN IF NOT EXISTS phone_encrypted TEXT;
ALTER TABLE leads    ADD COLUMN IF NOT EXISTS email_encrypted TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_encrypted  TEXT;

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Multi-tenant isolation: each client can only see their own rows.
-- Assumes the application sets:
--   SET app.current_client_id = '<client-uuid>'
-- before executing queries for a given client session.
-- The service_role bypass policy allows the backend to access all rows.
-- ============================================================

ALTER TABLE clients               ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE followups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_opt_outs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_api_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_reports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue             ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns             ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospects             ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails_sent           ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_store           ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_store         ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_prospects     ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_outcomes   ENABLE ROW LEVEL SECURITY;

-- ── Client isolation policies ──────────────────────────────

-- clients: a client row is visible only to that client
CREATE POLICY clients_isolation ON clients
  FOR ALL
  USING (id = current_setting('app.current_client_id', TRUE)::uuid);

-- calls
CREATE POLICY calls_isolation ON calls
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- leads
CREATE POLICY leads_isolation ON leads
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- messages
CREATE POLICY messages_isolation ON messages
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- followups
CREATE POLICY followups_isolation ON followups
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- appointments
CREATE POLICY appointments_isolation ON appointments
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- sms_opt_outs
CREATE POLICY sms_opt_outs_isolation ON sms_opt_outs
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- client_api_keys
CREATE POLICY client_api_keys_isolation ON client_api_keys
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- audit_log
CREATE POLICY audit_log_isolation ON audit_log
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- weekly_reports
CREATE POLICY weekly_reports_isolation ON weekly_reports
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- event_store
CREATE POLICY event_store_client_isolation ON event_store
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- campaigns
CREATE POLICY campaigns_client_isolation ON campaigns
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- prospects
CREATE POLICY prospects_client_isolation ON prospects
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- emails_sent
CREATE POLICY emails_sent_client_isolation ON emails_sent
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- job_queue
CREATE POLICY job_queue_client_isolation ON job_queue
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- campaign_prospects (link through campaigns)
CREATE POLICY campaign_prospects_client_isolation ON campaign_prospects
  FOR ALL
  USING (campaign_id IN (SELECT id FROM campaigns WHERE client_id = current_setting('app.current_client_id', TRUE)::uuid));

-- experiments
CREATE POLICY experiments_client_isolation ON experiments
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- experiment_assignments
CREATE POLICY experiment_assignments_client_isolation ON experiment_assignments
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- experiment_outcomes
CREATE POLICY experiment_outcomes_client_isolation ON experiment_outcomes
  FOR ALL
  USING (client_id = current_setting('app.current_client_id', TRUE)::uuid);

-- feature_store (link through leads)
CREATE POLICY feature_store_client_isolation ON feature_store
  FOR ALL
  USING (lead_id IN (SELECT id FROM leads WHERE client_id = current_setting('app.current_client_id', TRUE)::uuid));

-- ── Service role bypass policies ───────────────────────────
-- Allows the backend (service_role) to access all rows without client scoping.

CREATE POLICY service_role_bypass ON clients
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON calls
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON leads
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON messages
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON followups
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON appointments
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON sms_opt_outs
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON client_api_keys
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON audit_log
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON weekly_reports
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON job_queue
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON campaigns
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON prospects
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON emails_sent
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON event_store
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON feature_store
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON campaign_prospects
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON experiments
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON experiment_assignments
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
CREATE POLICY service_role_bypass ON experiment_outcomes
  FOR ALL USING (current_setting('role', TRUE) = 'service_role');
