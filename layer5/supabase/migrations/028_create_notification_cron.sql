-- ══════════════════════════════════════════════════════════════
-- Migration 028: Cron schedule for notification-dispatcher
-- ══════════════════════════════════════════════════════════════
-- Runs every 2 minutes. Finds undelivered alerts and dispatches
-- them to configured notification channels (Slack, webhook, email).
--
-- Prerequisites (same as migration 011):
--   1. pg_cron extension enabled
--   2. pg_net extension enabled
--   3. app.supabase_url and app.service_role_key set in DB config
-- ══════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'notification-dispatcher',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') ||
           '/functions/v1/notification-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ' || current_setting('app.settings.layerinfinite_internal_secret', true) || '"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
