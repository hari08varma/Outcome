-- ============================================================
-- LAYERINFINITE — Migration 017: Extend degradation_alert_events
-- ============================================================
-- Makes action_id, context_id, trend_delta nullable to support
-- new alert types that may not reference a specific action/context.
-- Adds alert_type column + new columns for gap detection data.
-- ============================================================

-- Make existing NOT NULL columns nullable for new alert types
ALTER TABLE degradation_alert_events
  ALTER COLUMN action_id DROP NOT NULL,
  ALTER COLUMN context_id DROP NOT NULL,
  ALTER COLUMN trend_delta DROP NOT NULL;

-- Add alert_type column with CHECK constraint
ALTER TABLE degradation_alert_events
  ADD COLUMN IF NOT EXISTS alert_type VARCHAR(50)
    DEFAULT 'degradation'
    CHECK (alert_type IN (
      'degradation',
      'score_flip',
      'latency_spike',
      'context_drift',
      'coordinated_failure'
    ));

-- Backfill existing rows
UPDATE degradation_alert_events
  SET alert_type = 'degradation'
  WHERE alert_type IS NULL;

-- Add severity column
ALTER TABLE degradation_alert_events
  ADD COLUMN IF NOT EXISTS severity VARCHAR(20)
    DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical'));

-- Add columns for new alert types
ALTER TABLE degradation_alert_events
  ADD COLUMN IF NOT EXISTS current_value    FLOAT,
  ADD COLUMN IF NOT EXISTS baseline_value   FLOAT,
  ADD COLUMN IF NOT EXISTS spike_ratio      FLOAT,
  ADD COLUMN IF NOT EXISTS affected_agent_count INT,
  ADD COLUMN IF NOT EXISTS message          TEXT;

-- Index for dedup queries by alert_type
CREATE INDEX IF NOT EXISTS idx_alert_events_type_dedup
  ON degradation_alert_events(customer_id, alert_type, detected_at DESC);

-- Index for latency spike queries
CREATE INDEX IF NOT EXISTS idx_alert_events_latency
  ON degradation_alert_events(alert_type, detected_at DESC)
  WHERE alert_type = 'latency_spike';
