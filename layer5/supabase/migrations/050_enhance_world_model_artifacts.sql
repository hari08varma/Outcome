-- ============================================================
-- LAYERINFINITE — Migration 050: Enhance World Model Artifacts
-- Adds fields for canary routing, DR estimator tracking,
-- distribution drift scoring, and performance gate results.
-- ============================================================

ALTER TABLE world_model_artifacts
  ADD COLUMN IF NOT EXISTS sample_count        INT,
  ADD COLUMN IF NOT EXISTS dr_estimate_used    BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS drift_score         FLOAT,
  ADD COLUMN IF NOT EXISTS is_canary           BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS canary_traffic_pct  INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS training_timestamp  TIMESTAMPTZ  DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS gate_results        JSONB;

-- Backfill training_timestamp for existing rows
UPDATE world_model_artifacts
  SET training_timestamp = created_at
  WHERE training_timestamp IS NULL;

-- Retention: keep at most 5 inactive artifacts per tier
-- Run after each promotion to clean up old history
CREATE OR REPLACE FUNCTION cleanup_old_model_artifacts()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM world_model_artifacts
  WHERE is_active = FALSE
    AND is_canary = FALSE
    AND id NOT IN (
      SELECT id FROM world_model_artifacts
      WHERE is_active = FALSE AND is_canary = FALSE
      ORDER BY created_at DESC
      LIMIT 5
    );
END;
$$;

-- Index to quickly find current canary model
CREATE INDEX IF NOT EXISTS idx_world_model_canary
  ON world_model_artifacts(is_canary, tier)
  WHERE is_canary = TRUE;
