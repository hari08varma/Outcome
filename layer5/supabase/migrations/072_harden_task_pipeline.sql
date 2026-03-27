-- ════════════════════════════════════════════════════════════
-- Migration 072: Harden task_name pipeline
-- Fixes: empty task_name, NOT NULL constraint, MV index,
--        refresh RPC, customer_id scoped merge guard,
--        action diversity check view.
-- Safe to run multiple times — all ops use IF NOT EXISTS / DO blocks.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ── Step 1: Backfill empty-string and NULL task_names ─────────────
-- Handles both NULL and '' (the empty string bug from .trim())
UPDATE fact_outcomes
SET task_name = 'unknown_task'
WHERE task_name IS NULL OR trim(task_name) = '';

-- ── Step 2: Verify zero bad rows remain before altering column ────
DO $$
DECLARE bad_count INT;
BEGIN
    SELECT COUNT(*) INTO bad_count
    FROM fact_outcomes
    WHERE task_name IS NULL OR trim(task_name) = '';

    IF bad_count > 0 THEN
        RAISE EXCEPTION 'Migration 072 aborted: % NULL/empty task_name rows remain. '
            'Fix them before applying NOT NULL constraint.', bad_count;
    END IF;
END $$;

-- ── Step 3: Apply NOT NULL + DEFAULT only after verification ──────
ALTER TABLE fact_outcomes
    ALTER COLUMN task_name SET DEFAULT 'unknown_task';

ALTER TABLE fact_outcomes
    ALTER COLUMN task_name SET NOT NULL;

-- ── Step 4: Add CHECK constraint to block empty strings ───────────
-- Prevents the .trim() → "" silent corruption bug permanently.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'fact_outcomes'
          AND constraint_name = 'chk_task_name_not_empty'
    ) THEN
        ALTER TABLE fact_outcomes
            ADD CONSTRAINT chk_task_name_not_empty
            CHECK (trim(task_name) <> '');
    END IF;
END $$;

-- ── Step 5: Verify MV columns before creating unique index ────────
-- Guards against index creation failing due to schema mismatch (#4)
-- Uses pg_catalog for reliable materialized-view introspection.
DO $$
DECLARE missing_cols TEXT;
BEGIN
    SELECT string_agg(col, ', ') INTO missing_cols
    FROM (
        VALUES ('customer_id'), ('task_name'), ('action_id')
    ) AS required(col)
    WHERE col NOT IN (
        SELECT a.attname::text
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relname = 'mv_task_action_performance'
          AND c.relkind = 'm'
          AND a.attnum > 0
          AND NOT a.attisdropped
    );

    IF missing_cols IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 072 aborted: mv_task_action_performance is missing '
            'required columns: %. Rebuild the MV first.', missing_cols;
    END IF;
END $$;

-- ── Step 6: Create unique index for CONCURRENTLY refresh ──────────
CREATE UNIQUE INDEX IF NOT EXISTS mv_tap_unique_idx
    ON mv_task_action_performance (customer_id, task_name, action_id);

-- ── Step 7: Create refresh RPC with fallback (#10) ────────────────
CREATE OR REPLACE FUNCTION refresh_task_action_performance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Attempt CONCURRENTLY first (non-blocking, requires unique index)
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_task_action_performance;
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
    EXCEPTION WHEN OTHERS THEN
        -- Fallback: blocking refresh if CONCURRENTLY fails (e.g. index missing)
        RAISE WARNING 'CONCURRENTLY refresh failed: %. Falling back to blocking refresh.', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_task_action_performance;
        REFRESH MATERIALIZED VIEW mv_action_scores;
    END;
END;
$$;

-- ── Step 8: Scoped customer_id merge helper (#6) ──────────────────
-- NOT executed automatically. Call manually after verifying both UUIDs.
-- Usage: SELECT merge_customer_outcomes('source-uuid', 'target-uuid');
CREATE OR REPLACE FUNCTION merge_customer_outcomes(
    source_customer_id UUID,
    target_customer_id UUID
)
RETURNS TABLE(rows_updated BIGINT, source_was_synthetic BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE updated_rows BIGINT;
DECLARE synthetic_rows BIGINT;
BEGIN
    -- Safety: never move synthetic/test data to production customer
    SELECT COUNT(*) INTO synthetic_rows
    FROM fact_outcomes
    WHERE customer_id = source_customer_id AND is_synthetic = TRUE;

    UPDATE fact_outcomes
    SET customer_id = target_customer_id
    WHERE customer_id = source_customer_id
      AND is_synthetic = FALSE     -- ← never move test data
      AND task_name IS NOT NULL;   -- ← only move rows with valid task

    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    RETURN QUERY SELECT updated_rows, synthetic_rows;
END;
$$;

-- ── Step 9: Action diversity guard view (#12) ─────────────────────
-- Use this to check which tasks have < 2 actions BEFORE calling the engine.
CREATE OR REPLACE VIEW v_task_action_diversity AS
SELECT
    customer_id,
    task_name,
    COUNT(DISTINCT action_id) AS distinct_actions,
    SUM(total_count)          AS total_outcomes,
    CASE
        WHEN COUNT(DISTINCT action_id) < 2 THEN 'insufficient_diversity'
        WHEN SUM(total_count) < 10         THEN 'insufficient_volume'
        ELSE 'ready'
    END AS recommendation_readiness
FROM mv_task_action_performance
GROUP BY customer_id, task_name;

-- ── Step 10: Initial MV refresh after migration ───────────────────
SELECT refresh_task_action_performance();

COMMIT;

-- ════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration)
-- ════════════════════════════════════════════════════════════

-- 1. Confirm zero bad task_names
SELECT COUNT(*) AS bad_rows
FROM fact_outcomes
WHERE task_name IS NULL OR trim(task_name) = '';
-- Expected: 0

-- 2. Check MV has data
SELECT customer_id, task_name, COUNT(*) AS action_count
FROM mv_task_action_performance
GROUP BY customer_id, task_name
ORDER BY action_count DESC
LIMIT 10;

-- 3. Check action diversity
SELECT * FROM v_task_action_diversity
ORDER BY recommendation_readiness, distinct_actions DESC;
-- Look for rows with status = 'ready'

-- 4. Test merge helper (DRY RUN — inspect first, don't run blindly)
-- SELECT * FROM merge_customer_outcomes(
--   'e5fee369-2b23-48e8-927f-2fd83783ea92',
--   '<your_dashboard_customer_uuid>'
-- );
