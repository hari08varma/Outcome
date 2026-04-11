-- ============================================================================
-- Migration 118: Cluster-level scoring materialized view
--
-- Creates mv_cluster_scores to aggregate success/score metrics by
-- semantic_cluster_key × customer_id. Used by the scoring engine
-- to provide Bayesian priors for cold-start actions based on how
-- similar actions in the same cluster perform.
--
-- Refresh: piggybacks on existing action scores refresh schedule.
-- ============================================================================

BEGIN;

-- ── Step 1: Cluster scores materialized view ─────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cluster_scores AS
SELECT
    semantic_cluster_key,
    customer_id::text AS customer_id,
    AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) AS cluster_success_rate,
    COUNT(*) AS cluster_total_attempts,
    AVG(outcome_score) AS cluster_avg_score,
    COUNT(DISTINCT action_id) AS cluster_action_count
FROM fact_outcomes
WHERE is_deleted = false
  AND semantic_cluster_key IS NOT NULL
  AND semantic_cluster_key <> ''
GROUP BY semantic_cluster_key, customer_id;

-- ── Step 2: Unique index for CONCURRENTLY refresh ────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cluster_scores_pk
    ON mv_cluster_scores (semantic_cluster_key, customer_id);

-- ── Step 3: Refresh function ─────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_cluster_scores()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cluster_scores;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'refresh_cluster_scores failed: %', SQLERRM;
END;
$$;

COMMENT ON MATERIALIZED VIEW mv_cluster_scores IS
    'Per-cluster scoring aggregates for Bayesian prior blending in cold-start action ranking.';

COMMIT;
