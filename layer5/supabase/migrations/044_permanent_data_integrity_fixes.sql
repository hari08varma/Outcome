-- ══════════════════════════════════════════════════════════════
-- Migration: 044_permanent_data_integrity_fixes.sql
-- Fixes:
--   1. outcome_score NOT NULL — backfills nulls, adds constraint
--   2. dim_contexts customer_id scoping — composite unique index
--      prevents cross-customer context sharing at the DB level
--
-- SAFE TO RUN: idempotent — every change is guarded by a DO block
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- FIX 1: outcome_score NOT NULL
-- ─────────────────────────────────────────────────────────────

-- Step 1: Backfill all existing NULL outcome_scores
UPDATE fact_outcomes
SET outcome_score = CASE
    WHEN success = TRUE  THEN 0.75
    WHEN success = FALSE THEN 0.25
    ELSE 0.5
END
WHERE outcome_score IS NULL;

-- Step 2: Verify zero NULLs remain before touching the schema
DO $$
DECLARE null_count INT;
BEGIN
    SELECT COUNT(*) INTO null_count
    FROM fact_outcomes
    WHERE outcome_score IS NULL;

    IF null_count > 0 THEN
        RAISE EXCEPTION
            'Aborting: % rows still have NULL outcome_score after backfill',
            null_count;
    END IF;
    RAISE NOTICE 'outcome_score backfill confirmed — 0 NULL rows remaining';
END $$;

-- Step 3: Add NOT NULL constraint (only if not already set)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name   = 'fact_outcomes'
        AND   column_name  = 'outcome_score'
        AND   is_nullable  = 'YES'
    ) THEN
        ALTER TABLE fact_outcomes
            ALTER COLUMN outcome_score SET NOT NULL;
        RAISE NOTICE 'Added NOT NULL to fact_outcomes.outcome_score';
    ELSE
        RAISE NOTICE 'fact_outcomes.outcome_score is already NOT NULL — skipping';
    END IF;
END $$;

-- Step 4: Add range check constraint (only if it does not already exist)
-- NOTE: PostgreSQL does not support "ADD CONSTRAINT IF NOT EXISTS"
-- so we guard it with a DO block checking information_schema first
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name      = 'fact_outcomes'
        AND   constraint_name = 'chk_outcome_score_range'
    ) THEN
        ALTER TABLE fact_outcomes
            ADD CONSTRAINT chk_outcome_score_range
                CHECK (outcome_score >= 0.0 AND outcome_score <= 1.0);
        RAISE NOTICE 'Added chk_outcome_score_range constraint';
    ELSE
        RAISE NOTICE 'chk_outcome_score_range already exists — skipping';
    END IF;
END $$;

-- Step 5: Set sensible default (belt-and-suspenders for direct inserts)
ALTER TABLE fact_outcomes
    ALTER COLUMN outcome_score SET DEFAULT 0.5;


-- ─────────────────────────────────────────────────────────────
-- FIX 2: dim_contexts customer_id scoping
-- ─────────────────────────────────────────────────────────────

-- Step 1: Ensure customer_id column exists on dim_contexts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name  = 'dim_contexts'
        AND   column_name = 'customer_id'
    ) THEN
        ALTER TABLE dim_contexts
            ADD COLUMN customer_id UUID REFERENCES dim_customers(customer_id);
        RAISE NOTICE 'Added customer_id column to dim_contexts';
    ELSE
        RAISE NOTICE 'dim_contexts.customer_id already exists — skipping';
    END IF;
END $$;

-- Step 2: Drop the old global unique constraint on (issue_type, environment)
-- This is what caused all customers to share a single context row
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name      = 'dim_contexts'
        AND   constraint_name = 'dim_contexts_issue_type_environment_key'
    ) THEN
        ALTER TABLE dim_contexts
            DROP CONSTRAINT dim_contexts_issue_type_environment_key;
        RAISE NOTICE 'Dropped old global unique constraint on dim_contexts';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name      = 'dim_contexts'
        AND   constraint_name = 'dim_contexts_issue_type_key'
    ) THEN
        ALTER TABLE dim_contexts
            DROP CONSTRAINT dim_contexts_issue_type_key;
        RAISE NOTICE 'Dropped old global issue_type unique constraint';
    END IF;
END $$;

-- Step 3: Add the correct composite unique index scoped per customer.
-- CREATE UNIQUE INDEX IF NOT EXISTS is valid PostgreSQL syntax (unlike ADD CONSTRAINT IF NOT EXISTS).
-- WHERE customer_id IS NOT NULL ensures orphaned old rows are excluded
-- so they do not violate this index.
CREATE UNIQUE INDEX IF NOT EXISTS
    idx_dim_contexts_customer_issue_env
    ON dim_contexts(customer_id, issue_type, environment)
    WHERE customer_id IS NOT NULL;

-- Step 4: Log how many orphaned contexts exist (created by the buggy code)
DO $$
DECLARE orphan_count INT;
BEGIN
    SELECT COUNT(*) INTO orphan_count
    FROM dim_contexts
    WHERE customer_id IS NULL;

    IF orphan_count > 0 THEN
        RAISE NOTICE
            '% orphaned context rows found (customer_id IS NULL). '
            'These are excluded by the WHERE clause on the new index. '
            'New outcomes will create correctly-scoped rows and ignore these.',
            orphan_count;
    ELSE
        RAISE NOTICE 'No orphaned context rows — clean state';
    END IF;
END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- POST-MIGRATION VERIFICATION
-- Copy and run these one at a time after COMMIT completes
-- ─────────────────────────────────────────────────────────────

-- 1. Zero null outcome_scores
-- SELECT COUNT(*) AS null_scores FROM fact_outcomes WHERE outcome_score IS NULL;
-- Expected: 0

-- 2. NOT NULL constraint is live
-- SELECT is_nullable FROM information_schema.columns
-- WHERE table_name = 'fact_outcomes' AND column_name = 'outcome_score';
-- Expected: NO

-- 3. Range check constraint exists
-- SELECT constraint_name FROM information_schema.table_constraints
-- WHERE table_name = 'fact_outcomes' AND constraint_name = 'chk_outcome_score_range';
-- Expected: 1 row

-- 4. Composite index exists on dim_contexts
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'dim_contexts' AND indexname = 'idx_dim_contexts_customer_issue_env';
-- Expected: 1 row

-- 5. After logging 10+ new outcomes via the API:
-- SELECT refresh_mv_action_scores();
-- SELECT refresh_mv_episode_patterns();
-- SELECT COUNT(*), MIN(weighted_success_rate), MAX(weighted_success_rate) FROM mv_action_scores;
-- Expected: count > 0, rates between 0 and 1
