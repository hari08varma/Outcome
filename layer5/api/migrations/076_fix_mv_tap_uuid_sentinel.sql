-- ════════════════════════════════════════════════════════════
-- Migration 076: Replace TEXT sentinel with UUID zero sentinel
-- in mv_task_action_performance.
-- Migration 075 applied a COALESCE(agent_id::text, '__unattributed__')
-- approach which changes the column type to TEXT. This migration
-- supersedes it: COALESCE(agent_id, '00000000-...'::uuid) keeps the
-- column type as UUID, making the unique index work natively without
-- any type cast and staying consistent with all FK references.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- Step 1: Drop MV and dependents (CASCADE drops v_task_action_diversity)
DROP MATERIALIZED VIEW IF EXISTS mv_task_action_performance CASCADE;

-- Step 2: Recreate with zero-UUID sentinel — agent_id stays UUID type
CREATE MATERIALIZED VIEW mv_task_action_performance AS
SELECT
    fo.customer_id,
    COALESCE(fo.agent_id, '00000000-0000-0000-0000-000000000000'::uuid) AS agent_id,
    fo.task_name,
    da.action_id,
    da.action_name,
    COUNT(*)                                                    AS total_count,
    SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)                AS success_count,
    ROUND(
        SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0), 4
    )                                                           AS success_rate,
    -- ml_score: most recent weighted signal from mv_action_scores
    -- NULL on cold-start; engine falls back to success_rate correctly
    (
        SELECT mas.weighted_success_rate
        FROM mv_action_scores mas
        WHERE mas.customer_id = fo.customer_id
          AND mas.action_id   = da.action_id
        ORDER BY mas.view_refreshed_at DESC NULLS LAST
        LIMIT 1
    )                                                           AS ml_score,
    MAX(fo.timestamp)                                           AS last_seen_at
FROM fact_outcomes fo
JOIN dim_actions da ON da.action_id = fo.action_id
WHERE fo.task_name IS NOT NULL
  AND trim(fo.task_name) <> ''
GROUP BY
    fo.customer_id,
    COALESCE(fo.agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    fo.task_name,
    da.action_id,
    da.action_name
WITH DATA;

-- Step 3: Unique index — no NULLs, REFRESH CONCURRENTLY now works correctly
CREATE UNIQUE INDEX mv_tap_unique_idx
    ON mv_task_action_performance (customer_id, agent_id, task_name, action_id);

-- Step 4: Performance index for recommendation engine query pattern
CREATE INDEX mv_tap_customer_task_idx
    ON mv_task_action_performance (customer_id, task_name);

-- Step 5: Recreate v_task_action_diversity — exclude zero-UUID sentinel
-- so readiness counts reflect only real attributed agents
CREATE OR REPLACE VIEW v_task_action_diversity AS
SELECT
    customer_id,
    task_name,
    COUNT(DISTINCT action_id)   AS distinct_actions,
    SUM(total_count)            AS total_outcomes,
    CASE
        WHEN COUNT(DISTINCT action_id) < 2 THEN 'insufficient_diversity'
        WHEN SUM(total_count) < 10         THEN 'insufficient_volume'
        ELSE 'ready'
    END AS recommendation_readiness
FROM mv_task_action_performance
WHERE agent_id <> '00000000-0000-0000-0000-000000000000'::uuid
GROUP BY customer_id, task_name;

-- Step 6: Refresh immediately
SELECT refresh_task_action_performance();

COMMIT;

-- ════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════

-- 1. No NULL agent_id rows
SELECT COUNT(*) AS null_rows FROM mv_task_action_performance WHERE agent_id IS NULL;
-- Expected: 0

-- 2. Sentinel only appears for truly unattributed outcomes
SELECT agent_id, COUNT(*) AS rows
FROM mv_task_action_performance
GROUP BY agent_id
ORDER BY agent_id;

-- 3. Diversity view excludes sentinel
SELECT * FROM v_task_action_diversity ORDER BY task_name;
