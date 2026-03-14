ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS verifier_source TEXT,
  ADD COLUMN IF NOT EXISTS verifier_value TEXT,
  ADD COLUMN IF NOT EXISTS discrepancy_detected BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN fact_outcomes.discrepancy_detected IS 'TRUE if agent claimed success but verifier signal indicated failure. Score was overridden.';
