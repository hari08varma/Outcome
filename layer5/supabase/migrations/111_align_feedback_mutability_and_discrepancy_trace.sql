-- ============================================================
-- LAYERINFINITE -- Migration 111: feedback mutability + discrepancy trace persistence
-- ============================================================
-- Purpose:
--   1) Make fact_outcomes mutability rules explicit for delayed-feedback reconciliation.
--   2) Persist machine-readable trace taxonomy and source execution metadata
--      in dim_discrepancy_log for failure traceability.
-- ============================================================

BEGIN;

-- -----------------------------------------------------------------
-- 1) Harden append-only guard with an explicit allowlist of mutable
--    reconciliation fields.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_outcome_update()
RETURNS TRIGGER AS $$
DECLARE
    old_immutable jsonb;
    new_immutable jsonb;
BEGIN
    old_immutable := to_jsonb(OLD)
        - 'outcome_score'
        - 'business_outcome'
        - 'feedback_received_at'
        - 'signal_pending'
        - 'signal_updated_at'
        - 'cross_event_status'
        - 'cross_event_last_updated'
        - 'execution_status'
        - 'failure_reason_code'
        - 'failure_stage'
        - 'status_origin';

    new_immutable := to_jsonb(NEW)
        - 'outcome_score'
        - 'business_outcome'
        - 'feedback_received_at'
        - 'signal_pending'
        - 'signal_updated_at'
        - 'cross_event_status'
        - 'cross_event_last_updated'
        - 'execution_status'
        - 'failure_reason_code'
        - 'failure_stage'
        - 'status_origin';

    IF old_immutable = new_immutable THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'fact_outcomes is append-only. Only feedback reconciliation fields may be updated.';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION prevent_outcome_update() IS
'Append-only guard for fact_outcomes: allows updates only to delayed-feedback reconciliation fields.';

-- -----------------------------------------------------------------
-- 2) Extend discrepancy log schema with structured trace metadata.
-- -----------------------------------------------------------------
ALTER TABLE IF EXISTS dim_discrepancy_log
    ADD COLUMN IF NOT EXISTS trace_reason_code VARCHAR(80) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS trace_stage VARCHAR(40) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS trace_gate VARCHAR(80) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS source_execution_status VARCHAR(16) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS source_status_origin VARCHAR(40) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS source_failure_reason_code VARCHAR(80) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS source_failure_stage VARCHAR(40) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS trace_context JSONB DEFAULT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'dim_discrepancy_log'
          AND constraint_name = 'chk_discrepancy_source_execution_status_enum'
    ) THEN
        ALTER TABLE dim_discrepancy_log
            ADD CONSTRAINT chk_discrepancy_source_execution_status_enum
            CHECK (
                source_execution_status IS NULL
                OR source_execution_status IN ('COMPLETED', 'FAILED')
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_discrepancy_reason_unresolved
    ON dim_discrepancy_log (customer_id, trace_reason_code, created_at DESC)
    WHERE resolved = FALSE AND trace_reason_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discrepancy_source_failure_reason
    ON dim_discrepancy_log (customer_id, source_failure_reason_code)
    WHERE source_failure_reason_code IS NOT NULL;

COMMENT ON COLUMN dim_discrepancy_log.trace_reason_code IS
'Machine-readable discrepancy reason code used by traceability/debug pipelines.';

COMMENT ON COLUMN dim_discrepancy_log.trace_stage IS
'Pipeline stage where discrepancy surfaced (signal_wait, ingest_validation, delayed_feedback, etc.).';

COMMENT ON COLUMN dim_discrepancy_log.trace_gate IS
'Gate/checkpoint identifier that produced this discrepancy.';

COMMENT ON COLUMN dim_discrepancy_log.source_execution_status IS
'Execution status snapshot from related outcome row at discrepancy detection time.';

COMMENT ON COLUMN dim_discrepancy_log.source_status_origin IS
'Origin of execution status (explicit, inferred_from_success, inferred_from_score, reconciled_feedback).';

COMMENT ON COLUMN dim_discrepancy_log.source_failure_reason_code IS
'Failure reason code snapshot from related outcome row at discrepancy detection time.';

COMMENT ON COLUMN dim_discrepancy_log.source_failure_stage IS
'Failure stage snapshot from related outcome row at discrepancy detection time.';

COMMENT ON COLUMN dim_discrepancy_log.trace_context IS
'Additional machine-readable trace payload (JSON) for discrepancy diagnostics.';

COMMIT;

-- Verification
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'dim_discrepancy_log'
  AND column_name IN (
    'trace_reason_code',
    'trace_stage',
    'trace_gate',
    'source_execution_status',
    'source_status_origin',
    'source_failure_reason_code',
    'source_failure_stage',
    'trace_context'
  )
ORDER BY ordinal_position;
