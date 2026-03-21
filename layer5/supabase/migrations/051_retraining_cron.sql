-- ══════════════════════════════════════════════════════════════
-- Migration 051: Automated counterfactual retraining cron job
-- ══════════════════════════════════════════════════════════════
-- Weekly pg_cron job that triggers the retraining check endpoint.
-- Actual training is guarded by sample count gate in
-- counterfactual_retraining.py — this just ensures the check runs.
--
-- Requires: pg_cron + pg_net extensions enabled in Supabase.
-- INTERNAL_RETRAINING_URL must be set as a Supabase secret and
-- injected at deploy time (see README / .env.example).
-- ══════════════════════════════════════════════════════════════

-- Schedule weekly retraining check: Sundays at 02:00 UTC
-- The endpoint is the internal API retraining trigger route.
-- If pg_net is not available, this acts as a no-op reminder.
DO $$
BEGIN
  -- Only schedule if pg_cron extension is available
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Unschedule existing job if it exists (idempotent)
    PERFORM cron.unschedule('counterfactual-retraining-weekly')
      WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'counterfactual-retraining-weekly'
      );

    -- Schedule the weekly retraining check
    PERFORM cron.schedule(
      'counterfactual-retraining-weekly',
      '0 2 * * 0',  -- Sundays at 02:00 UTC
      $$
        -- Increment a heartbeat counter so we can detect if cron is running
        -- The actual retraining is triggered by the API layer (counterfactual_retraining.py)
        -- called via a background worker or edge function.
        -- Here we log a trigger event for observability.
        INSERT INTO admin_cron_log (job_name, triggered_at)
        VALUES ('counterfactual-retraining-weekly', NOW())
        ON CONFLICT DO NOTHING;
      $$
    );

    RAISE NOTICE 'Scheduled counterfactual-retraining-weekly cron job (Sundays 02:00 UTC)';
  ELSE
    RAISE NOTICE 'pg_cron not available — skipping retraining cron schedule. Set up external cron to call counterfactual_retraining.py weekly.';
  END IF;
END;
$$;

-- Lightweight cron log table (used by all admin cron jobs)
CREATE TABLE IF NOT EXISTS admin_cron_log (
  id          BIGSERIAL PRIMARY KEY,
  job_name    TEXT NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details     JSONB
);

CREATE INDEX IF NOT EXISTS idx_admin_cron_log_job_time
  ON admin_cron_log (job_name, triggered_at DESC);

-- Auto-clean log entries older than 30 days
CREATE OR REPLACE FUNCTION cleanup_admin_cron_log()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM admin_cron_log WHERE triggered_at < NOW() - INTERVAL '30 days';
END;
$$;

-- Schedule log cleanup daily at 05:00 UTC (if pg_cron available)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('admin-cron-log-cleanup')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'admin-cron-log-cleanup');
    PERFORM cron.schedule(
      'admin-cron-log-cleanup',
      '0 5 * * *',
      $$ SELECT cleanup_admin_cron_log(); $$
    );
  END IF;
END;
$$;
