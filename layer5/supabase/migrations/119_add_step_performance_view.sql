-- ============================================================================
-- Migration 119: Step-level performance materialized view
--
-- Creates mv_step_performance to track per-step success rates in
-- multi-step agent episodes. Used by get-scores to identify
-- bottleneck steps in LangGraph-style sequential workflows.
--
-- Maps (action_id, customer_id, episode_position) to:
--   - step_success_rate
--   - step_attempts
--   - step_avg_latency
--   - step_avg_score
-- ============================================================================

BEGIN;

-- ── Step 1: Step performance materialized view ───────────────
-- Note: fact_decisions.episode_position may be NULL for non-episode
-- outcomes. This view only includes rows with explicit positions.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_step_performance AS
SELECT
    fo.action_id,
    fo.customer_id::text AS customer_id,
    fd.episode_position,
    AVG(CASE WHEN fo.success THEN 1.0 ELSE 0.0 END) AS step_success_rate,
    COUNT(*) AS step_attempts,
    AVG(fo.response_time_ms) FILTER (WHERE fo.response_time_ms > 0) AS step_avg_latency,
    AVG(fo.outcome_score) AS step_avg_score
FROM fact_outcomes fo
JOIN fact_decisions fd ON fd.outcome_id = fo.outcome_id
WHERE fo.is_deleted = false
  AND fd.episode_position IS NOT NULL
GROUP BY fo.action_id, fo.customer_id, fd.episode_position;

-- ── Step 2: Unique index for CONCURRENTLY refresh ────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_step_performance_pk
    ON mv_step_performance (action_id, customer_id, episode_position);

-- ── Step 3: Lookup index for get-scores queries ──────────────
CREATE INDEX IF NOT EXISTS idx_mv_step_performance_lookup
    ON mv_step_performance (customer_id, action_id);

-- ── Step 4: Refresh function ─────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_step_performance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_step_performance;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'refresh_step_performance failed: %', SQLERRM;
END;
$$;

COMMENT ON MATERIALIZED VIEW mv_step_performance IS
    'Per-step success rates for multi-step agent episodes. Identifies bottleneck steps.';

COMMIT;
