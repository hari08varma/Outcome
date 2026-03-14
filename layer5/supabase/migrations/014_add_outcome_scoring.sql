-- ============================================================
-- LAYERINFINITE — Migration 014: Outcome Scoring (3-Tier Outcome Model)
-- ============================================================
-- Adds nuanced outcome scoring to fact_outcomes:
--   outcome_score      → 0.0–1.0 (NULL = binary fallback)
--   business_outcome   → resolved/partial/failed/unknown
--   feedback_signal    → immediate/delayed/none
--   feedback_received_at → when delayed feedback arrived
--
-- Creates fact_outcome_feedback for delayed outcome signals.
--
-- BACKWARD COMPATIBLE: All new columns are nullable/defaulted.
-- Old records: outcome_score=NULL → scoring uses success::FLOAT
-- ============================================================

-- ────────────────────────────────────────────
-- 1. Add outcome scoring columns to fact_outcomes
-- ────────────────────────────────────────────
ALTER TABLE fact_outcomes
  ADD COLUMN outcome_score      FLOAT
    CHECK (outcome_score >= 0.0 AND outcome_score <= 1.0),
  ADD COLUMN business_outcome   VARCHAR(20)
    CHECK (business_outcome IN (
      'resolved', 'partial', 'failed', 'unknown'
    )),
  ADD COLUMN feedback_signal    VARCHAR(20)
    DEFAULT 'immediate'
    CHECK (feedback_signal IN (
      'immediate', 'delayed', 'none'
    )),
  ADD COLUMN feedback_received_at TIMESTAMPTZ;

-- ────────────────────────────────────────────
-- 2. Replace append-only trigger to permit
--    feedback updates (outcome_score, business_outcome,
--    feedback_received_at) — nothing else.
--
--    This is the ONE permitted UPDATE path on fact_outcomes.
--    All other columns remain immutable.
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_outcome_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow updates ONLY to feedback fields (via outcome-feedback endpoint)
  IF (
    OLD.agent_id          IS NOT DISTINCT FROM NEW.agent_id AND
    OLD.action_id         IS NOT DISTINCT FROM NEW.action_id AND
    OLD.context_id        IS NOT DISTINCT FROM NEW.context_id AND
    OLD.customer_id       IS NOT DISTINCT FROM NEW.customer_id AND
    OLD.session_id        IS NOT DISTINCT FROM NEW.session_id AND
    OLD.timestamp         IS NOT DISTINCT FROM NEW.timestamp AND
    OLD.success           IS NOT DISTINCT FROM NEW.success AND
    OLD.response_time_ms  IS NOT DISTINCT FROM NEW.response_time_ms AND
    OLD.error_code        IS NOT DISTINCT FROM NEW.error_code AND
    OLD.error_message     IS NOT DISTINCT FROM NEW.error_message AND
    OLD.raw_context       IS NOT DISTINCT FROM NEW.raw_context AND
    OLD.is_synthetic      IS NOT DISTINCT FROM NEW.is_synthetic AND
    OLD.is_deleted        IS NOT DISTINCT FROM NEW.is_deleted AND
    OLD.deleted_at        IS NOT DISTINCT FROM NEW.deleted_at AND
    OLD.salience_score    IS NOT DISTINCT FROM NEW.salience_score AND
    OLD.feedback_signal   IS NOT DISTINCT FROM NEW.feedback_signal
  ) THEN
    -- Only feedback fields changed — permitted
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'fact_outcomes is APPEND-ONLY. Only outcome_score, business_outcome, and feedback_received_at may be updated (via delayed feedback). Attempted illegal update on outcome_id: %', OLD.outcome_id;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────
-- 3. Delayed outcome feedback table
-- ────────────────────────────────────────────
CREATE TABLE fact_outcome_feedback (
  feedback_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome_id        UUID NOT NULL REFERENCES fact_outcomes(outcome_id),
  customer_id       UUID NOT NULL REFERENCES dim_customers(customer_id),
  final_score       FLOAT NOT NULL
    CHECK (final_score >= 0.0 AND final_score <= 1.0),
  business_outcome  VARCHAR(20) NOT NULL
    CHECK (business_outcome IN (
      'resolved', 'partial', 'failed', 'unknown'
    )),
  feedback_notes    TEXT,
  received_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_outcome_feedback_outcome ON fact_outcome_feedback(outcome_id);
CREATE INDEX idx_outcome_feedback_customer ON fact_outcome_feedback(customer_id);

-- ────────────────────────────────────────────
-- 4. RLS on fact_outcome_feedback
-- ────────────────────────────────────────────
ALTER TABLE fact_outcome_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_feedback_isolation" ON fact_outcome_feedback
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);
