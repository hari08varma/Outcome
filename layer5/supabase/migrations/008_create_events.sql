-- ============================================================
-- LAYERINFINITE — Migration 008: Temporal Event Tables
-- ============================================================
-- Phase 4 — Trend Detection & Degradation Alerting
--
-- Tables:
--   degradation_alert_events — emitted when trend_delta < -0.15
--   trend_change_events      — emitted on score flip > 0.4
--
-- These tables are written by the trend-detector Edge Function
-- (runs nightly) and read by the dashboard + API.
-- ============================================================

-- ────────────────────────────────────────────
-- TABLE 1: Degradation Alert Events
-- Emitted when an action's week-over-week
-- trend_delta drops below -0.15 (critical).
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS degradation_alert_events (
  alert_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id      UUID NOT NULL REFERENCES dim_actions(action_id),
  context_id     UUID NOT NULL REFERENCES dim_contexts(context_id),
  customer_id    UUID NOT NULL REFERENCES dim_customers(customer_id),
  action_name    VARCHAR(255),
  context_type   VARCHAR(255),
  trend_delta    FLOAT NOT NULL,
  current_success_rate FLOAT,
  previous_success_rate FLOAT,
  total_attempts INTEGER,
  detected_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  acknowledged   BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(255)
);

-- ────────────────────────────────────────────
-- TABLE 2: Trend Change Events (Score Flips)
-- Emitted when an action's success rate flips
-- by more than 0.4 within 7 days.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trend_change_events (
  event_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id              UUID NOT NULL REFERENCES dim_actions(action_id),
  context_id             UUID NOT NULL REFERENCES dim_contexts(context_id),
  customer_id            UUID NOT NULL REFERENCES dim_customers(customer_id),
  action_name            VARCHAR(255),
  old_success_rate       FLOAT NOT NULL,
  new_success_rate       FLOAT NOT NULL,
  score_flip_magnitude   FLOAT NOT NULL,
  affected_outcomes_count INTEGER DEFAULT 0,
  detected_at            TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  acknowledged           BOOLEAN DEFAULT FALSE
);

-- ────────────────────────────────────────────
-- Indexes for event queries
-- ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_degradation_alerts_customer
  ON degradation_alert_events(customer_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_degradation_alerts_action
  ON degradation_alert_events(action_id, context_id);

CREATE INDEX IF NOT EXISTS idx_degradation_alerts_unack
  ON degradation_alert_events(acknowledged)
  WHERE acknowledged = FALSE;

CREATE INDEX IF NOT EXISTS idx_trend_changes_customer
  ON trend_change_events(customer_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_trend_changes_action
  ON trend_change_events(action_id, context_id);

-- ────────────────────────────────────────────
-- RLS on event tables
-- ────────────────────────────────────────────
ALTER TABLE degradation_alert_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_isolation_degradation_alerts" ON degradation_alert_events
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);

ALTER TABLE trend_change_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_isolation_trend_changes" ON trend_change_events
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);
