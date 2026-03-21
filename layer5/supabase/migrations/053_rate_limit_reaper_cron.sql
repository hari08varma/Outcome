-- ============================================================
-- LAYERINFINITE — Migration 053: Rate Limit Reaper Cron
-- Schedules the cleanup function every minute via pg_cron.
-- ============================================================

-- Remove existing schedule if present (idempotent)
SELECT cron.unschedule('rate-limit-reaper')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'rate-limit-reaper'
  );

SELECT cron.schedule(
  'rate-limit-reaper',
  '* * * * *',  -- Every minute
  $$ SELECT cleanup_rate_limit_buckets(); $$
);
