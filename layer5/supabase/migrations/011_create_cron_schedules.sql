-- ══════════════════════════════════════════════════════════════
-- Migration 011: Create pg_cron schedules for Edge Functions
-- ══════════════════════════════════════════════════════════════
-- Prerequisites:
--   1. pg_cron extension available (Supabase Pro plan or self-hosted)
--   2. pg_net extension enabled (for http_post)
--   3. Set these in Supabase Dashboard → Settings → Database → Configuration:
--        app.supabase_url = https://[project-ref].supabase.co
--        app.layerinfinite_internal_secret = [generate with openssl rand -hex 32]
-- ══════════════════════════════════════════════════════════════

-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage to postgres role
GRANT USAGE ON SCHEMA cron TO postgres;

-- ── Scoring engine: every 5 minutes ──────────────────────────
-- Refreshes mv_action_scores (CONCURRENTLY) for sub-5ms queries
SELECT cron.schedule(
  'scoring-engine-refresh',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') ||
           '/functions/v1/scoring-engine',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || current_setting('app.layerinfinite_internal_secret', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Trust updater batch: every 5 minutes ─────────────────────
-- Recalculates trust scores for all agents with recent outcomes
SELECT cron.schedule(
  'trust-updater-batch',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') ||
           '/functions/v1/trust-updater',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || current_setting('app.layerinfinite_internal_secret', true),
      'Content-Type', 'application/json'
    ),
    body := '{"mode":"batch"}'::jsonb
  );
  $$
);

-- ── Trend detector: nightly at 02:00 UTC ─────────────────────
-- Detects degradation (trend_delta < -0.15) and score flips (> 0.4)
SELECT cron.schedule(
  'trend-detector-nightly',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') ||
           '/functions/v1/trend-detector',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || current_setting('app.layerinfinite_internal_secret', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Pruning scheduler: nightly at 03:00 UTC ──────────────────
-- ⚠️  DESTRUCTIVE: archives >90d, cold-deletes >365d
-- Enable Supabase PITR BEFORE running this for the first time
SELECT cron.schedule(
  'pruning-scheduler-nightly',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') ||
           '/functions/v1/pruning-scheduler',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || current_setting('app.layerinfinite_internal_secret', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
