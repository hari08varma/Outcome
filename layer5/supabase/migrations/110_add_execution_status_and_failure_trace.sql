-- ============================================================
-- LAYERINFINITE -- Migration 110: Binary execution status + failure trace
-- ============================================================
-- Adds first-class execution status fields to fact_outcomes.
--
-- Goals:
--   1) Support explicit binary outcome status (COMPLETED | FAILED)
--   2) Persist structured failure trace metadata for failed outcomes
--   3) Keep backward compatibility for historical rows (status can be NULL)
--
-- Notes:
--   - Historical rows remain valid with execution_status = NULL.
--   - New writes should set execution_status + status_origin.
-- ============================================================

BEGIN;

ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS execution_status VARCHAR(16) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS failure_reason_code VARCHAR(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS failure_stage VARCHAR(40) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS status_origin VARCHAR(40) NOT NULL DEFAULT 'inferred_from_success';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'chk_fact_outcomes_execution_status_enum'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_execution_status_enum
      CHECK (
        execution_status IS NULL
        OR execution_status IN ('COMPLETED', 'FAILED')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'chk_fact_outcomes_status_origin_enum'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_status_origin_enum
      CHECK (
        status_origin IN (
          'explicit',
          'inferred_from_success',
          'inferred_from_score',
          'reconciled_feedback'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'chk_fact_outcomes_failure_fields_for_status'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_failure_fields_for_status
      CHECK (
        execution_status IS NULL
        OR (
          execution_status = 'COMPLETED'
          AND failure_reason_code IS NULL
          AND failure_stage IS NULL
        )
        OR (
          execution_status = 'FAILED'
          AND failure_reason_code IS NOT NULL
          AND failure_stage IS NOT NULL
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'chk_fact_outcomes_success_status_coherence'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_success_status_coherence
      CHECK (
        execution_status IS NULL
        OR (execution_status = 'COMPLETED' AND success = TRUE)
        OR (execution_status = 'FAILED' AND success = FALSE)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_execution_status
  ON fact_outcomes (customer_id, execution_status, timestamp DESC)
  WHERE execution_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_failure_reason_code
  ON fact_outcomes (customer_id, failure_reason_code)
  WHERE failure_reason_code IS NOT NULL;

COMMENT ON COLUMN fact_outcomes.execution_status IS
  'Binary execution result: COMPLETED or FAILED. NULL for legacy rows before migration 110.';

COMMENT ON COLUMN fact_outcomes.failure_reason_code IS
  'Structured failure code for failed execution rows (for traceability and analytics).';

COMMENT ON COLUMN fact_outcomes.failure_stage IS
  'Pipeline stage where failure occurred (for traceability), set when execution_status=FAILED.';

COMMENT ON COLUMN fact_outcomes.status_origin IS
  'How execution_status was derived: explicit|inferred_from_success|inferred_from_score|reconciled_feedback.';

COMMIT;

-- Verification
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'fact_outcomes'
  AND column_name IN (
    'execution_status',
    'failure_reason_code',
    'failure_stage',
    'status_origin'
  )
ORDER BY ordinal_position;
