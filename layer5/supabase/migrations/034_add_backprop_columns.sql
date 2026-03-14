-- ============================================================
-- LAYER5 — Migration 034: Reward Backpropagation
-- ============================================================
-- Adds columns to track Temporal Difference (TD) updates.
-- ============================================================

ALTER TABLE fact_outcomes 
  ADD COLUMN IF NOT EXISTS backprop_adjusted BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS backprop_episode_id UUID REFERENCES fact_episodes(episode_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_episode 
  ON fact_outcomes(backprop_episode_id) 
  WHERE backprop_episode_id IS NOT NULL;
