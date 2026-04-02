-- ════════════════════════════════════════════════════════════
-- Migration 078: Supporting index on mv_action_scores for the
-- correlated subquery in mv_task_action_performance.
--
-- WHY: The MV definition (since 074) contains a correlated subquery:
--   SELECT weighted_success_rate FROM mv_action_scores
--   WHERE customer_id = ? AND action_id = ?
--   ORDER BY view_refreshed_at DESC NULLS LAST LIMIT 1
-- Without this index, every GROUP BY row in mv_task_action_performance
-- requires a full scan of mv_action_scores. At scale (100 customers,
-- 50 action combinations each = 5,000 groups), a single MV refresh
-- executes 5,000 sequential scans. This index reduces each lookup to
-- an index range scan on (customer_id, action_id) with a single row
-- returned by the view_refreshed_at sort — O(log n) per group instead
-- of O(n) per group.
-- ════════════════════════════════════════════════════════════

-- Guard: only create if mv_action_scores exists
-- (it may not exist on cold environments before the scoring engine runs)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'mv_action_scores'
    ) THEN
        -- Composite index: equality on (customer_id, action_id),
        -- descending on view_refreshed_at to match ORDER BY DESC
        IF NOT EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE indexname = 'mv_action_scores_customer_action_refreshed_idx'
        ) THEN
            EXECUTE 'CREATE INDEX mv_action_scores_customer_action_refreshed_idx
                     ON mv_action_scores (customer_id, action_id, view_refreshed_at DESC NULLS LAST)';
            RAISE NOTICE 'Created mv_action_scores_customer_action_refreshed_idx';
        ELSE
            RAISE NOTICE 'mv_action_scores_customer_action_refreshed_idx already exists — skipping';
        END IF;
    ELSE
        RAISE NOTICE 'mv_action_scores does not exist yet — index will be created when the MV is populated';
    END IF;
END $$;

-- ════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════

-- 1. Confirm index exists (or mv_action_scores doesn't exist yet — both OK)
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE indexname = 'mv_action_scores_customer_action_refreshed_idx';
-- Expected: 1 row with the composite index definition, OR 0 rows if
-- mv_action_scores not yet populated (acceptable — DO block logged a notice)

-- 2. After index exists, verify the correlated subquery uses it:
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT * FROM mv_task_action_performance LIMIT 1;
-- Look for "Index Scan using mv_action_scores_customer_action_refreshed_idx"
-- in the EXPLAIN output. If you see "Seq Scan on mv_action_scores", the
-- index is not being used — check statistics with ANALYZE mv_action_scores.
