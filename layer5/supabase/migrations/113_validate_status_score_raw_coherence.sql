-- ============================================================
-- LAYERINFINITE -- Migration 113: Validate status/score coherence constraint
-- ============================================================
-- Purpose:
--   Final post-deploy hardening step for migration 112.
--   Validates chk_fact_outcomes_status_score_raw_coherence only after
--   production data is confirmed clean.
--
-- Safety:
--   - Idempotent: validates only when the constraint exists and is unvalidated.
--   - Guarded: raises with violating-row count instead of partially applying.
-- ============================================================

BEGIN;

DO $$
DECLARE
    v_violation_count BIGINT := 0;
BEGIN
    -- Skip if the staged constraint is absent.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_fact_outcomes_status_score_raw_coherence'
          AND conrelid = 'fact_outcomes'::regclass
    ) THEN
        RAISE NOTICE 'Constraint chk_fact_outcomes_status_score_raw_coherence not found; skipping validation.';
        RETURN;
    END IF;

    -- If already validated, no-op.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_fact_outcomes_status_score_raw_coherence'
          AND conrelid = 'fact_outcomes'::regclass
          AND convalidated = false
    ) THEN
        RAISE NOTICE 'Constraint chk_fact_outcomes_status_score_raw_coherence already validated; skipping.';
        RETURN;
    END IF;

    -- Pre-check violating rows so failures are explicit and actionable.
    SELECT COUNT(*)
    INTO v_violation_count
    FROM fact_outcomes
    WHERE execution_status IS NOT NULL
      AND outcome_score_raw IS NOT NULL
      AND NOT (
        (execution_status = 'COMPLETED' AND outcome_score_raw >= 0.5)
        OR (execution_status = 'FAILED' AND outcome_score_raw <= 0.5)
      );

    IF v_violation_count > 0 THEN
        RAISE EXCEPTION
            'Cannot validate chk_fact_outcomes_status_score_raw_coherence: % violating rows remain.',
            v_violation_count
            USING HINT = 'Fix conflicting execution_status/outcome_score_raw rows, then re-run migration 113.';
    END IF;

    ALTER TABLE fact_outcomes
        VALIDATE CONSTRAINT chk_fact_outcomes_status_score_raw_coherence;
END $$;

COMMIT;

-- Verification
SELECT
    conname,
    convalidated
FROM pg_constraint
WHERE conname = 'chk_fact_outcomes_status_score_raw_coherence'
  AND conrelid = 'fact_outcomes'::regclass;
