-- ============================================================
-- LAYERINFINITE — Migration 057: Embedding Drift Cleanup Cron
-- Daily retention sweep for drift reports.
-- Note: drift detection itself is triggered via admin API endpoint
-- POST /v1/admin/embedding-drift/check (not via DB cron).
-- ============================================================

SELECT cron.unschedule('embedding-drift-report-cleanup')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'embedding-drift-report-cleanup'
  );

SELECT cron.schedule(
  'embedding-drift-report-cleanup',
  '0 4 * * *',  -- Daily at 4am UTC
  $$ SELECT cleanup_drift_reports(); $$
);
