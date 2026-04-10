-- ============================================================
-- LAYERINFINITE — Migration 107: Validate deferred ingestion checks
-- ============================================================
-- Why:
--   Migrations 101 and 102 introduced NOT VALID constraints to avoid a
--   table scan during deploy. This migration completes the lifecycle by
--   validating those constraints once production data is backfilled.
--
-- Safety:
--   - Idempotent: validates only when the target constraint exists and is
--     still unvalidated.
--   - No schema shape changes.
-- ============================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fact_outcomes_ingestion_source_check'
          AND convalidated = false
    ) THEN
        ALTER TABLE fact_outcomes
            VALIDATE CONSTRAINT fact_outcomes_ingestion_source_check;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fact_outcomes_outcome_class_check'
          AND convalidated = false
    ) THEN
        ALTER TABLE fact_outcomes
            VALIDATE CONSTRAINT fact_outcomes_outcome_class_check;
    END IF;
END $$;

COMMIT;
