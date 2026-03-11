-- ══════════════════════════════════════════════════════════════
-- LAYER5 — Migration 027: Notification Channels + Delivery Log
-- ══════════════════════════════════════════════════════════════
-- Stores customer notification channel configuration.
-- One customer can have multiple channels
-- (email + Slack + webhook all active simultaneously).
-- ══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────
-- TABLE 1: alert_notification_channels
-- Customer-configured alert delivery channels.
-- Supports email, Slack webhooks, and HTTP webhooks.
-- Per-severity and per-type filtering.
-- Written by dashboard, read by notification-dispatcher.
-- ────────────────────────────────────────────
CREATE TABLE alert_notification_channels (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID        NOT NULL REFERENCES dim_customers(customer_id),
  channel_type    TEXT        NOT NULL
                              CHECK (channel_type IN (
                                'email',
                                'slack_webhook',
                                'webhook'
                              )),
  destination     TEXT        NOT NULL,
  label           TEXT        NOT NULL DEFAULT '',
  min_severity    TEXT        NOT NULL DEFAULT 'warning'
                              CHECK (min_severity IN (
                                'info',
                                'warning',
                                'critical'
                              )),
  alert_type_filter TEXT[]    NOT NULL DEFAULT '{}',
  is_active       BOOL        NOT NULL DEFAULT TRUE,
  last_delivery_at    TIMESTAMPTZ,
  last_delivery_ok    BOOL,
  last_delivery_error TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE alert_notification_channels IS
  'Customer-configured alert delivery channels. '
  'Supports email, Slack webhooks, and HTTP webhooks. '
  'Per-severity and per-type filtering. '
  'Written by dashboard, read by notification-dispatcher Edge Function.';

-- Trigger: auto-update updated_at
-- (update_updated_at_column already exists from migration 020)
CREATE TRIGGER notification_channels_updated_at
  BEFORE UPDATE ON alert_notification_channels
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────
-- TABLE 2: alert_notification_log
-- Immutable delivery receipt for every alert dispatch attempt.
-- Used to prevent duplicate delivery and diagnose failures.
-- ────────────────────────────────────────────
CREATE TABLE alert_notification_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID        NOT NULL
                              REFERENCES alert_notification_channels(id),
  alert_id        UUID        NOT NULL
                              REFERENCES degradation_alert_events(alert_id),
  delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success         BOOL        NOT NULL,
  error_message   TEXT,
  http_status     INT,
  CONSTRAINT unique_channel_alert UNIQUE (channel_id, alert_id)
);

COMMENT ON TABLE alert_notification_log IS
  'Immutable delivery receipt for every alert dispatch attempt. '
  'Used to prevent duplicate delivery and diagnose failures.';

-- ────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────
CREATE INDEX idx_notification_channels_customer
  ON alert_notification_channels (customer_id);

CREATE INDEX idx_notification_channels_active
  ON alert_notification_channels (customer_id, is_active)
  WHERE is_active = TRUE;

CREATE INDEX idx_notification_log_channel
  ON alert_notification_log (channel_id, delivered_at DESC);

CREATE INDEX idx_notification_log_alert
  ON alert_notification_log (alert_id);

-- ────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────
ALTER TABLE alert_notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_notification_log ENABLE ROW LEVEL SECURITY;

-- Customers manage their own channels
CREATE POLICY notif_channels_select ON alert_notification_channels
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid()::uuid);

CREATE POLICY notif_channels_insert ON alert_notification_channels
  FOR INSERT TO authenticated
  WITH CHECK (customer_id = auth.uid()::uuid);

CREATE POLICY notif_channels_update ON alert_notification_channels
  FOR UPDATE TO authenticated
  USING (customer_id = auth.uid()::uuid);

CREATE POLICY notif_channels_delete ON alert_notification_channels
  FOR DELETE TO authenticated
  USING (customer_id = auth.uid()::uuid);

-- Log is read-only for customers (join through their channels)
CREATE POLICY notif_log_select ON alert_notification_log
  FOR SELECT TO authenticated
  USING (
    channel_id IN (
      SELECT id FROM alert_notification_channels
      WHERE customer_id = auth.uid()::uuid
    )
  );
