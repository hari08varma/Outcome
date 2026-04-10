-- ============================================================
-- LAYERINFINITE -- Migration 112: Status hardening + trace naming + cohort source labels
-- ============================================================
-- Goals:
--   1) Harden execution failure vocab and score/status coherence (safe forward rollout).
--   2) Normalize discrepancy trace naming with reason_code + trace_payload.
--   3) Persist confidence source labels on recommendation cohort cycles.
--
-- Notes:
--   - Legacy discrepancy columns remain for backward compatibility.
--   - New constraints are added as NOT VALID first; vocab values are backfilled,
--     then validated where safe.
-- ============================================================

BEGIN;

-- -----------------------------------------------------------------
-- 1) fact_outcomes: bounded failure vocab and score/status coherence
-- -----------------------------------------------------------------

-- Backfill invalid/missing failure metadata for FAILED rows into bounded fallback tokens.
UPDATE fact_outcomes
SET failure_reason_code = 'unknown_failure'
WHERE execution_status = 'FAILED'
  AND (
    failure_reason_code IS NULL
    OR failure_reason_code NOT IN (
      'execution_failed',
      'timeout_error',
      'validation_failed',
      'dependency_failure',
      'policy_blocked',
      'feedback_marked_failure',
      'cross_event_conflict',
      'unknown_failure'
    )
  );

UPDATE fact_outcomes
SET failure_stage = 'unknown_stage'
WHERE execution_status = 'FAILED'
  AND (
    failure_stage IS NULL
    OR failure_stage NOT IN (
      'action_selection',
      'action_execution',
      'ingest_validation',
      'verification',
      'delayed_feedback',
      'downstream_signal',
      'policy_gate',
      'unknown_stage'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_fact_outcomes_failure_reason_code_vocab'
      AND conrelid = 'fact_outcomes'::regclass
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_failure_reason_code_vocab
      CHECK (
        failure_reason_code IS NULL
        OR failure_reason_code IN (
          'execution_failed',
          'timeout_error',
          'validation_failed',
          'dependency_failure',
          'policy_blocked',
          'feedback_marked_failure',
          'cross_event_conflict',
          'unknown_failure'
        )
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_fact_outcomes_failure_stage_vocab'
      AND conrelid = 'fact_outcomes'::regclass
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_failure_stage_vocab
      CHECK (
        failure_stage IS NULL
        OR failure_stage IN (
          'action_selection',
          'action_execution',
          'ingest_validation',
          'verification',
          'delayed_feedback',
          'downstream_signal',
          'policy_gate',
          'unknown_stage'
        )
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_fact_outcomes_status_score_raw_coherence'
      AND conrelid = 'fact_outcomes'::regclass
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_status_score_raw_coherence
      CHECK (
        execution_status IS NULL
        OR outcome_score_raw IS NULL
        OR (execution_status = 'COMPLETED' AND outcome_score_raw >= 0.5)
        OR (execution_status = 'FAILED' AND outcome_score_raw <= 0.5)
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_fact_outcomes_failure_reason_code_vocab'
      AND conrelid = 'fact_outcomes'::regclass
      AND convalidated = false
  ) THEN
    ALTER TABLE fact_outcomes
      VALIDATE CONSTRAINT chk_fact_outcomes_failure_reason_code_vocab;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_fact_outcomes_failure_stage_vocab'
      AND conrelid = 'fact_outcomes'::regclass
      AND convalidated = false
  ) THEN
    ALTER TABLE fact_outcomes
      VALIDATE CONSTRAINT chk_fact_outcomes_failure_stage_vocab;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_failure_stage
  ON fact_outcomes (customer_id, failure_stage, timestamp DESC)
  WHERE failure_stage IS NOT NULL;

-- -----------------------------------------------------------------
-- 2) dim_discrepancy_log: normalized reason_code + trace_payload fields
-- -----------------------------------------------------------------
ALTER TABLE IF EXISTS dim_discrepancy_log
  ADD COLUMN IF NOT EXISTS reason_code VARCHAR(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS trace_payload JSONB DEFAULT NULL;

UPDATE dim_discrepancy_log
SET reason_code = COALESCE(reason_code, trace_reason_code)
WHERE reason_code IS NULL
  AND trace_reason_code IS NOT NULL;

UPDATE dim_discrepancy_log
SET trace_payload = COALESCE(trace_payload, trace_context)
WHERE trace_payload IS NULL
  AND trace_context IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discrepancy_reason_code_unresolved
  ON dim_discrepancy_log (customer_id, reason_code, created_at DESC)
  WHERE resolved = FALSE AND reason_code IS NOT NULL;

COMMENT ON COLUMN dim_discrepancy_log.reason_code IS
'Machine-readable discrepancy reason code (normalized naming). Mirrors trace_reason_code for backward compatibility.';

COMMENT ON COLUMN dim_discrepancy_log.trace_payload IS
'Machine-readable discrepancy trace payload (normalized naming). Mirrors trace_context for backward compatibility.';

-- -----------------------------------------------------------------
-- 3) recommendation_cohort_cycles: persist confidence-source labels
-- -----------------------------------------------------------------
ALTER TABLE IF EXISTS recommendation_cohort_cycles
  ADD COLUMN IF NOT EXISTS opened_confidence_source VARCHAR(32) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS opened_confidence_source_reason TEXT DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_reco_cycle_opened_confidence_source_vocab'
      AND conrelid = 'recommendation_cohort_cycles'::regclass
  ) THEN
    ALTER TABLE recommendation_cohort_cycles
      ADD CONSTRAINT chk_reco_cycle_opened_confidence_source_vocab
      CHECK (
        opened_confidence_source IS NULL
        OR opened_confidence_source IN (
          'bootstrap',
          'empirical_warmup',
          'empirical_stable',
          'hybrid_shadow'
        )
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_reco_cycle_opened_confidence_source_vocab'
      AND conrelid = 'recommendation_cohort_cycles'::regclass
      AND convalidated = false
  ) THEN
    ALTER TABLE recommendation_cohort_cycles
      VALIDATE CONSTRAINT chk_reco_cycle_opened_confidence_source_vocab;
  END IF;
END $$;

COMMENT ON COLUMN recommendation_cohort_cycles.opened_confidence_source IS
'Confidence source label captured when the cycle was opened (bootstrap|empirical_warmup|empirical_stable|hybrid_shadow).';

COMMENT ON COLUMN recommendation_cohort_cycles.opened_confidence_source_reason IS
'Machine-readable reason describing why opened_confidence_source was assigned.';

COMMIT;

-- Verification
SELECT
  conname,
  convalidated
FROM pg_constraint
WHERE conname IN (
  'chk_fact_outcomes_failure_reason_code_vocab',
  'chk_fact_outcomes_failure_stage_vocab',
  'chk_fact_outcomes_status_score_raw_coherence',
  'chk_reco_cycle_opened_confidence_source_vocab'
)
ORDER BY conname;
