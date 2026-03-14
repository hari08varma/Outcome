-- ============================================================
-- LAYERINFINITE — Migration 035: Reward Backpropagation Columns
-- ============================================================
-- Adds columns to fact_outcomes to track Temporal Difference
-- (TD) reward adjustments. Safe to run multiple times.
-- ============================================================

ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS backprop_adjusted   BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS backprop_episode_id UUID REFERENCES action_sequences(episode_id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_episode
  ON fact_outcomes(backprop_episode_id)
  WHERE backprop_episode_id IS NOT NULL;
