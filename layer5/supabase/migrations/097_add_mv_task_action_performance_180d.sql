-- ============================================================================
-- Migration 097: Rolling 180-day task performance MV
-- Adds mv_task_action_performance_180d so recommendation ranking no longer
-- depends on all-time aggregate counts from mv_task_action_performance.
--
-- Safe to rerun:
--   - DROP/CREATE for the new MV only
--   - IF NOT EXISTS for indexes
--   - CREATE OR REPLACE for refresh RPCs
-- ============================================================================

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS mv_task_action_performance_180d;

CREATE MATERIALIZED VIEW mv_task_action_performance_180d AS
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
        / NULLIF(COUNT(*), 0),
        4
    )                                                           AS success_rate,
    (
        SELECT mas.weighted_success_rate
        FROM mv_action_scores mas
        WHERE mas.customer_id = fo.customer_id
          AND mas.action_id = da.action_id
        ORDER BY mas.view_refreshed_at DESC NULLS LAST
        LIMIT 1
    )                                                           AS ml_score,
    MAX(fo.timestamp)                                           AS last_seen_at
FROM fact_outcomes fo
JOIN dim_actions da ON da.action_id = fo.action_id
WHERE fo.task_name IS NOT NULL
  AND trim(fo.task_name) <> ''
  AND fo.is_deleted = false
  AND fo.is_synthetic = false
  AND fo.timestamp >= (NOW() - INTERVAL '180 days')
GROUP BY
    fo.customer_id,
    COALESCE(fo.agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    fo.task_name,
    da.action_id,
    da.action_name
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_tap_180d_unique_idx
    ON mv_task_action_performance_180d (customer_id, agent_id, task_name, action_id);

CREATE INDEX IF NOT EXISTS mv_tap_180d_customer_task_idx
    ON mv_task_action_performance_180d (customer_id, task_name);

CREATE OR REPLACE FUNCTION refresh_task_action_performance_180d()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_task_action_performance_180d;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'CONCURRENTLY refresh failed for mv_task_action_performance_180d: %. Falling back to blocking refresh.', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_task_action_performance_180d;
    END;
END;
$$;

-- Keep legacy refresh entrypoint but make it refresh both task MVs and
-- mv_action_scores in one call.
CREATE OR REPLACE FUNCTION refresh_task_action_performance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_matviews
        WHERE schemaname = 'public'
          AND matviewname = 'mv_task_action_performance'
    ) THEN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_task_action_performance;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'CONCURRENTLY refresh failed for mv_task_action_performance: %. Falling back to blocking refresh.', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_task_action_performance;
        END;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_matviews
        WHERE schemaname = 'public'
          AND matviewname = 'mv_task_action_performance_180d'
    ) THEN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_task_action_performance_180d;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'CONCURRENTLY refresh failed for mv_task_action_performance_180d: %. Falling back to blocking refresh.', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_task_action_performance_180d;
        END;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_matviews
        WHERE schemaname = 'public'
          AND matviewname = 'mv_action_scores'
    ) THEN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'CONCURRENTLY refresh failed for mv_action_scores: %. Falling back to blocking refresh.', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_action_scores;
        END;
    END IF;
END;
$$;

SELECT refresh_task_action_performance_180d();

COMMIT;

-- Verification
SELECT COUNT(*) FROM mv_task_action_performance_180d;
SELECT customer_id, task_name, COUNT(*) AS action_rows
FROM mv_task_action_performance_180d
GROUP BY customer_id, task_name
ORDER BY action_rows DESC
LIMIT 10;
