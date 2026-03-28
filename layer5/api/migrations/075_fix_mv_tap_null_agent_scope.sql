-- ════════════════════════════════════════════════════════════
-- Migration 075: Fix NULL agent_id scoping in mv_task_action_performance
-- Root cause: NULL agent_id rows break the unique index (each NULL is
-- distinct in Postgres), causing REFRESH CONCURRENTLY to fail silently
-- and creating ghost rows that contaminate All-Agents blended results.
-- Fix: COALESCE(agent_id, '__unattributed__') so index is always non-null.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- Step 1: Drop existing MV and its dependents (CASCADE drops v_task_action_diversity)
DROP MATERIALIZED VIEW IF EXISTS mv_task_action_performance CASCADE;

-- Step 2: Recreate MV with COALESCE guard on agent_id
-- agent_id is UUID in fact_outcomes; cast to TEXT so the string sentinel
-- '__unattributed__' is valid and the unique index can never have NULL entries.
CREATE MATERIALIZED VIEW mv_task_action_performance AS
SELECT
    fo.customer_id,
    COALESCE(fo.agent_id::text, '__unattributed__')     AS agent_id,
    fo.task_name,
    da.action_id,
    da.action_name,
    COUNT(*)                                            AS total_count,
    SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)        AS success_count,
    ROUND(
        SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0),
        4
    )                                                   AS success_rate,
    -- ml_score: correlated subquery against mv_action_scores
    -- NULL on cold-start; engine falls back to success_rate correctly
    (
        SELECT mas.weighted_success_rate
        FROM mv_action_scores mas
        WHERE mas.customer_id = fo.customer_id
          AND mas.action_id   = da.action_id
        ORDER BY mas.view_refreshed_at DESC NULLS LAST
        LIMIT 1
    )                                                   AS ml_score,
    MAX(fo.timestamp)                                   AS last_seen_at
FROM fact_outcomes fo
JOIN dim_actions da
    ON da.action_id = fo.action_id
WHERE fo.task_name IS NOT NULL
  AND trim(fo.task_name) <> ''
GROUP BY
    fo.customer_id,
    COALESCE(fo.agent_id::text, '__unattributed__'),
    fo.task_name,
    da.action_id,
    da.action_name
WITH DATA;

-- Step 3: Unique index — required for REFRESH CONCURRENTLY
-- Now safe: agent_id is never NULL (COALESCE guarantees it)
CREATE UNIQUE INDEX mv_tap_unique_idx
    ON mv_task_action_performance (customer_id, agent_id, task_name, action_id);

-- Step 4: Performance index for recommendation engine query pattern
CREATE INDEX mv_tap_customer_task_idx
    ON mv_task_action_performance (customer_id, task_name);

-- Step 5: Recreate v_task_action_diversity (dropped via CASCADE above)
-- Excludes __unattributed__ sentinel so readiness counts reflect real agents only
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
WHERE agent_id <> '__unattributed__'
GROUP BY customer_id, task_name;

-- Step 6: Refresh so data is live immediately
SELECT refresh_task_action_performance();

COMMIT;

-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run after migration)
-- ════════════════════════════════════════════════════════════

-- 1. Confirm no NULL agent_id rows in MV
SELECT COUNT(*) AS null_agent_rows
FROM mv_task_action_performance
WHERE agent_id IS NULL;
-- Expected: 0

-- 2. Confirm __unattributed__ sentinel appears only for truly unattributed outcomes
SELECT agent_id, COUNT(*) AS rows
FROM mv_task_action_performance
GROUP BY agent_id
ORDER BY agent_id;
-- __unattributed__ row appears only if fact_outcomes had agent_id = NULL rows

-- 3. Confirm diversity view excludes sentinel
SELECT * FROM v_task_action_diversity ORDER BY task_name;
-- Should not show __unattributed__ as an entry
