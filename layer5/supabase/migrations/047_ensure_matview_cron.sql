-- ============================================================
-- LAYERINFINITE MIGRATION SAFETY RULES
-- 1. NEVER add NOT NULL columns to fact_outcomes without a DEFAULT or full backfill.
-- 4. ALL new FK columns on insert paths MUST be nullable (DEFAULT NULL).
-- ============================================================
--
-- RULE: Always wrap cron.schedule() in a DO block with a prior unschedule check.
-- Bare cron.schedule() throws if jobname already exists, causing silent migration
-- failure when re-run. The DO block pattern is idempotent: safe to run multiple times.
--
-- RULE: Use direct SQL refresh (SELECT refresh_mv_action_scores()) as the primary
-- cron mechanism, NOT Edge Function HTTP calls. Supabase Edge Functions sleep after
-- inactivity on the free tier — a direct SQL job bypasses this cold-start problem.
-- The Edge Function cron from migration 011 is retained as Belt+suspenders.
--
-- Bug 2 root cause:
--   pg_cron job 'scoring-engine-refresh' from migration 011 calls Edge Function
--   via HTTP. On free tier, Edge Function sleeps and the HTTP call fails silently.
--   mv_action_scores never refreshes → Overview shows "No scores yet".
--
-- Fix:
--   Register a SECOND cron job that calls refresh_mv_action_scores() directly via SQL.
--   This is free-tier safe: no Edge Function, no HTTP, no cold-start.
-- ============================================================

-- Unschedule the direct-refresh job if it already exists, then re-register it cleanly.
-- This ensures the cron schedule is always correct after re-running this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mv-action-scores-direct-refresh') THEN
    PERFORM cron.unschedule('mv-action-scores-direct-refresh');
  END IF;
END $$;

SELECT cron.schedule(
  'mv-action-scores-direct-refresh',
  '*/5 * * * *',
  $$SELECT refresh_mv_action_scores();$$
);
