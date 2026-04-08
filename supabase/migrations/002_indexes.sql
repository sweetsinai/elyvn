-- ============================================================
-- Migration 002: Performance indexes + event_store CHECK constraint
-- ============================================================

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_calls_direction ON calls(direction, client_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage     ON leads(stage, client_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);

-- Enforce valid event_type values on event_store
-- Wrapped in a DO block so re-running this file is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_event_type' AND conrelid = 'event_store'::regclass
  ) THEN
    ALTER TABLE event_store
      ADD CONSTRAINT chk_event_type CHECK (event_type IN (
        'LeadCreated',
        'LeadStageChanged',
        'LeadScored',
        'BrainActionExecuted',
        'EmailSent',
        'SMSSent',
        'AppointmentBooked',
        'ReplyReceived',
        'BatchScoringCompleted',
        'FollowupScheduled',
        'OptOutRecorded',
        'BrainReasoningCaptured',
        'CallAnswered'
      ));
  END IF;
END;
$$;
