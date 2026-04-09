-- ══════════════════════════════════════════════════════════════
-- LAYERINFINITE — Migration 102: Outcome Score Inference Columns
-- ══════════════════════════════════════════════════════════════
-- Adds two columns to fact_outcomes for the 3-layer inference engine:
--
--   inference_confidence  — 0.0–1.0 confidence of the inferred outcome_score.
--                           NULL when score was developer-provided (score_origin='provided').
--   outcome_class         — Classified outcome category from inference engine.
--                           NULL for pre-migration rows and developer-provided scores.
--
-- Safety:
--   - Fully idempotent: all DDL uses IF NOT EXISTS.
--   - Backward compatible: both columns are nullable.
--   - No destructive operations (no DROP, no RENAME, no UPDATE).
--   - fact_outcomes APPEND-ONLY trigger is NOT affected (columns are set at INSERT time only).
-- ══════════════════════════════════════════════════════════════

-- 1. inference_confidence
--    Confidence score (0.0–1.0) of the inferred outcome_score.
--    NULL when developer provides explicit outcome_score (no inference ran).
--    Capped at 0.85 by the inference engine — inference is never fully authoritative.
ALTER TABLE fact_outcomes
    ADD COLUMN IF NOT EXISTS inference_confidence numeric(5,4);

-- 2. outcome_class
--    Classified outcome from the 3-layer inference engine.
--    Provides a categorical label alongside the numeric score.
--    NULL for old rows and developer-provided scores.
ALTER TABLE fact_outcomes
    ADD COLUMN IF NOT EXISTS outcome_class text;

-- Constraint: enforce valid outcome_class values at DB level.
-- NOT VALID: skip row-by-row scan on existing rows (all are NULL anyway).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fact_outcomes_outcome_class_check'
    ) THEN
        ALTER TABLE fact_outcomes
            ADD CONSTRAINT fact_outcomes_outcome_class_check
            CHECK (outcome_class IN (
                'success', 'partial_success', 'degraded', 'failure', 'uncertain'
            ))
            NOT VALID;
    END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────
-- Enables dashboard queries: "show me all inferred outcomes" or
-- "show me uncertain outcomes that need human review".
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_outcome_class
    ON fact_outcomes (outcome_class, customer_id)
    WHERE outcome_class IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_inference_confidence
    ON fact_outcomes (inference_confidence)
    WHERE inference_confidence IS NOT NULL;

-- ── Verification ──────────────────────────────────────────────
SELECT
    column_name,
    data_type,
    column_default,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'fact_outcomes'
  AND column_name IN (
    'inference_confidence',
    'outcome_class'
  )
ORDER BY ordinal_position;

-- Expected:
-- inference_confidence | numeric(5,4) | NULL | YES
-- outcome_class        | text         | NULL | YES

COMMENT ON COLUMN fact_outcomes.inference_confidence IS
    'Confidence of the inferred outcome_score (0.0–1.0). NULL when score was developer-provided.';

COMMENT ON COLUMN fact_outcomes.outcome_class IS
    'Classified outcome: success|partial_success|degraded|failure|uncertain. '
    'Set by server-side 3-layer inference engine. NULL for old rows and developer-provided scores.';
