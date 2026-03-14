-- ============================================================
-- LAYERINFINITE — Migration 024: Foundation Indexes
-- ============================================================
-- Creates all indexes for the new foundation tables:
--   fact_decisions, action_sequences,
--   fact_outcome_counterfactuals, world_model_artifacts
--
-- Follows existing convention from 005_create_indexes.sql.
-- All indexes created BEFORE data writes for safety.
-- ============================================================

-- ────────────────────────────────────────────
-- fact_decisions indexes
-- ────────────────────────────────────────────
CREATE INDEX idx_fact_decisions_agent_id
  ON fact_decisions (agent_id);

CREATE INDEX idx_fact_decisions_context_hash
  ON fact_decisions (context_hash);

CREATE INDEX idx_fact_decisions_episode_id
  ON fact_decisions (episode_id)
  WHERE episode_id IS NOT NULL;

CREATE INDEX idx_fact_decisions_outcome_id
  ON fact_decisions (outcome_id)
  WHERE outcome_id IS NOT NULL;

CREATE INDEX idx_fact_decisions_created_at
  ON fact_decisions (created_at DESC);

-- Composite: most common query pattern
-- (agent + context + time descending)
CREATE INDEX idx_fact_decisions_agent_context
  ON fact_decisions (agent_id, context_hash, created_at DESC);

-- ────────────────────────────────────────────
-- action_sequences indexes
-- ────────────────────────────────────────────
CREATE INDEX idx_action_sequences_episode_id
  ON action_sequences (episode_id);

CREATE INDEX idx_action_sequences_agent_id
  ON action_sequences (agent_id);

CREATE INDEX idx_action_sequences_context_hash
  ON action_sequences (context_hash);

CREATE INDEX idx_action_sequences_closed
  ON action_sequences (closed_at)
  WHERE closed_at IS NOT NULL;

-- GIN index for array containment queries
-- "find all sequences that contain 'update_app'"
CREATE INDEX idx_action_sequences_gin
  ON action_sequences USING GIN (action_sequence);

-- ────────────────────────────────────────────
-- fact_outcome_counterfactuals indexes
-- ────────────────────────────────────────────
CREATE INDEX idx_counterfactuals_decision_id
  ON fact_outcome_counterfactuals (decision_id);

CREATE INDEX idx_counterfactuals_unchosen_action
  ON fact_outcome_counterfactuals (unchosen_action_id);

CREATE INDEX idx_counterfactuals_real_outcome
  ON fact_outcome_counterfactuals (real_outcome_id);

CREATE INDEX idx_counterfactuals_context_hash
  ON fact_outcome_counterfactuals (context_hash);

-- For training data queries: fetch all counterfactuals
-- with sufficient weight for a context type
CREATE INDEX idx_counterfactuals_weight_context
  ON fact_outcome_counterfactuals (context_hash, ips_weight DESC)
  WHERE ips_weight >= 0.05;

-- ────────────────────────────────────────────
-- world_model_artifacts indexes
-- ────────────────────────────────────────────
CREATE INDEX idx_world_model_tier_active
  ON world_model_artifacts (tier, is_active);

CREATE INDEX idx_world_model_trained_at
  ON world_model_artifacts (trained_at DESC);
