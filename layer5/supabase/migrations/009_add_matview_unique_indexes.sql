-- ============================================================
-- LAYERINFINITE — Migration 009: UNIQUE Indexes for CONCURRENTLY Refresh
-- ============================================================
-- CRITICAL: REFRESH MATERIALIZED VIEW CONCURRENTLY requires
-- a UNIQUE index on the view. Without it, the command errors:
-- "ERROR: cannot refresh concurrently a materialized view
--  without a unique index"
--
-- These indexes are in a SEPARATE migration from 005 because:
-- 1. The matviews (004) must exist before we can index them
-- 2. Applied migrations are IMMUTABLE (Rule 9) — we cannot
--    modify 005_create_indexes.sql after it has been applied.
-- ============================================================

-- UNIQUE index for mv_action_scores
-- Composite: action + context + customer uniquely identifies one row
CREATE UNIQUE INDEX IF NOT EXISTS ux_action_scores_composite
  ON mv_action_scores(action_id, context_id, customer_id);

-- UNIQUE index for mv_episode_patterns
-- Composite: context + customer + sequence hash uniquely identifies one row
CREATE UNIQUE INDEX IF NOT EXISTS ux_episode_patterns_composite
  ON mv_episode_patterns(context_id, customer_id, action_sequence_hash);
