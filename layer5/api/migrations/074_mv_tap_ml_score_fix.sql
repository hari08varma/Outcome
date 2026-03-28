-- ════════════════════════════════════════════════════════════
-- Migration 074: Fix ml_score source in mv_task_action_performance
-- Replaces LEFT JOIN agent_trust_scores (wrong) with
-- LEFT JOIN mv_action_scores (correct — has composite ML scores).
-- This wires the 5-factor ML engine output into recommendations.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- Step 1: Drop existing MV and its indexes (CASCADE handles dependents)
DROP MATERIALIZED VIEW IF EXISTS mv_task_action_performance CASCADE;

-- Step 2: Recreate with correct ml_score source
CREATE MATERIALIZED VIEW mv_task_action_performance AS
SELECT
    fo.customer_id,
    fo.agent_id,
    fo.task_name,
    da.action_id,
    da.action_name,
    COUNT(*)                                                    AS total_count,
    SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)                AS success_count,
    ROUND(
        SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0),
        4
    )                                                           AS success_rate,
    -- ← FIXED: pull composite ML score from mv_action_scores
    -- Uses the most recent context_id match for this customer+action pair.
    -- NULL when no ML score exists yet (cold-start) — engine falls back
    -- to success_rate via rankingScore() which is the correct behaviour.
    (
        SELECT mas.composite_score
        FROM mv_action_scores mas
        WHERE mas.customer_id = fo.customer_id
          AND mas.action_id   = da.action_id
        ORDER BY mas.view_refreshed_at DESC NULLS LAST
        LIMIT 1
    )                                                           AS ml_score,
    MAX(fo.created_at)                                          AS last_seen_at
FROM fact_outcomes fo
JOIN dim_actions da
    ON da.action_id = fo.action_id
WHERE fo.task_name IS NOT NULL
  AND trim(fo.task_name) <> ''
GROUP BY
    fo.customer_id,
    fo.agent_id,
    fo.task_name,
    da.action_id,
    da.action_name
WITH DATA;

-- Step 3: Unique index — required for REFRESH CONCURRENTLY later
CREATE UNIQUE INDEX mv_tap_unique_idx
    ON mv_task_action_performance (customer_id, agent_id, task_name, action_id);

-- Step 4: Performance index for the recommendation engine query pattern
CREATE INDEX mv_tap_customer_task_idx
    ON mv_task_action_performance (customer_id, task_name);

-- Step 5: Refresh immediately
SELECT refresh_task_action_performance();

COMMIT;

-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run after migration)
-- ════════════════════════════════════════════════════════════

-- 1. Confirm ml_score is now populated (not null) for actions
--    that have entries in mv_action_scores
SELECT
    task_name,
    action_name,
    total_count,
    success_rate,
    ml_score,
    CASE WHEN ml_score IS NOT NULL THEN '✅ ML wired' ELSE '⚠ cold-start (null ok)' END AS status
FROM mv_task_action_performance
WHERE customer_id = 'df0c88a7-a9aa-4543-a6d5-84ae6847dea6'
ORDER BY task_name, action_name;

-- 2. Confirm mv_action_scores has data to join from
SELECT action_id, composite_score, view_refreshed_at
FROM mv_action_scores
WHERE customer_id = 'df0c88a7-a9aa-4543-a6d5-84ae6847dea6'
LIMIT 10;

-- If mv_action_scores is empty → ml_score stays NULL (expected for cold-start).
-- The recommendation engine correctly falls back to success_rate.
-- ml_score will populate as context_id-based decisions are scored.
