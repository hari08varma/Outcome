-- ============================================================
-- LAYERINFINITE — Migration 055: Trust Snapshot Cleanup Cron
-- Daily retention sweep: remove snapshots older than 7 days.
-- ============================================================

SELECT cron.unschedule('trust-snapshot-cleanup')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'trust-snapshot-cleanup'
  );

SELECT cron.schedule(
  'trust-snapshot-cleanup',
  '0 3 * * *',  -- Daily at 3am UTC
  $$ SELECT cleanup_trust_snapshots(); $$
);
