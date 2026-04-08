-- ============================================================
-- Migration 003: Complete RLS — add app.bypass_rls service policies
-- ============================================================
-- Context:
--   001_initial_schema.sql already enables RLS on all client-data tables
--   and adds client isolation policies + service_role (Supabase role) bypass.
--
--   This migration adds a second bypass path keyed on the custom GUC
--   app.bypass_rls = 'true', which the Node.js backend can set explicitly
--   via SET LOCAL / set_config() for admin operations that must cross
--   tenant boundaries regardless of the connected DB role.
--
--   Usage in application code:
--     await client.query("SELECT set_config('app.bypass_rls','true',true)");
--     -- ... admin queries ...
--
-- Tables covered (all tables that store per-client data):
--   clients, calls, leads, messages, followups, appointments,
--   sms_opt_outs, client_api_keys, audit_log, weekly_reports,
--   job_queue, campaigns, prospects, emails_sent, event_store,
--   feature_store, campaign_prospects, experiments,
--   experiment_assignments, experiment_outcomes
-- ============================================================

-- ── clients ──────────────────────────────────────────────────
CREATE POLICY clients_service_bypass ON clients
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── calls ─────────────────────────────────────────────────────
CREATE POLICY calls_service_bypass ON calls
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── leads ─────────────────────────────────────────────────────
CREATE POLICY leads_service_bypass ON leads
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── messages ──────────────────────────────────────────────────
CREATE POLICY messages_service_bypass ON messages
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── followups ─────────────────────────────────────────────────
CREATE POLICY followups_service_bypass ON followups
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── appointments ──────────────────────────────────────────────
CREATE POLICY appointments_service_bypass ON appointments
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── sms_opt_outs ──────────────────────────────────────────────
CREATE POLICY sms_opt_outs_service_bypass ON sms_opt_outs
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── client_api_keys ───────────────────────────────────────────
CREATE POLICY client_api_keys_service_bypass ON client_api_keys
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── audit_log ─────────────────────────────────────────────────
CREATE POLICY audit_log_service_bypass ON audit_log
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── weekly_reports ────────────────────────────────────────────
CREATE POLICY weekly_reports_service_bypass ON weekly_reports
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── job_queue ─────────────────────────────────────────────────
CREATE POLICY job_queue_service_bypass ON job_queue
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── campaigns ─────────────────────────────────────────────────
CREATE POLICY campaigns_service_bypass ON campaigns
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── prospects ─────────────────────────────────────────────────
CREATE POLICY prospects_service_bypass ON prospects
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── emails_sent ───────────────────────────────────────────────
CREATE POLICY emails_sent_service_bypass ON emails_sent
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── event_store ───────────────────────────────────────────────
CREATE POLICY event_store_service_bypass ON event_store
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── feature_store ─────────────────────────────────────────────
CREATE POLICY feature_store_service_bypass ON feature_store
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── campaign_prospects ────────────────────────────────────────
CREATE POLICY campaign_prospects_service_bypass ON campaign_prospects
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── experiments ───────────────────────────────────────────────
CREATE POLICY experiments_service_bypass ON experiments
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── experiment_assignments ────────────────────────────────────
CREATE POLICY experiment_assignments_service_bypass ON experiment_assignments
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');

-- ── experiment_outcomes ───────────────────────────────────────
CREATE POLICY experiment_outcomes_service_bypass ON experiment_outcomes
  FOR ALL
  USING (current_setting('app.bypass_rls', TRUE) = 'true');
