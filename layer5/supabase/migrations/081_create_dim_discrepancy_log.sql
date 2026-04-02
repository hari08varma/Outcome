-- ══════════════════════════════════════════════════════════════
-- Migration 070: Create dim_discrepancy_log
-- Part of: Discrepancy Detection Pipeline (Phase 8)
-- Tracks unresolved contract/signal discrepancies for investigation.
-- Safe to run multiple times — uses IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dim_discrepancy_log (
    discrepancy_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id      UUID         NOT NULL,
    outcome_id       UUID         REFERENCES fact_outcomes(outcome_id) ON DELETE CASCADE,
    registration_id  UUID         REFERENCES dim_pending_signal_registrations(registration_id) ON DELETE SET NULL,
    contract_id      UUID         REFERENCES dim_signal_contracts(contract_id) ON DELETE SET NULL,

    action_name      VARCHAR(200) NOT NULL,
    discrepancy_type VARCHAR(50)  NOT NULL,
    -- values: 'outcome_mismatch' | 'expired_no_signal' | 'confidence_below_threshold' | 'contract_violation'

    expected_outcome BOOLEAN      DEFAULT NULL,
    actual_outcome   BOOLEAN      DEFAULT NULL, -- what fact_outcomes.success recorded
    signal_confidence FLOAT       DEFAULT NULL,
    threshold_used   FLOAT        DEFAULT NULL,
    detail           TEXT         DEFAULT NULL,

    resolved         BOOLEAN      NOT NULL DEFAULT FALSE,
    resolved_at      TIMESTAMPTZ  DEFAULT NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discrepancy_by_customer
ON dim_discrepancy_log (customer_id)
WHERE resolved = FALSE;

CREATE INDEX IF NOT EXISTS idx_discrepancy_by_outcome
ON dim_discrepancy_log (outcome_id);

CREATE INDEX IF NOT EXISTS idx_discrepancy_by_type
ON dim_discrepancy_log (discrepancy_type, customer_id);

-- ── Verification ────────────────────────────────────────────────
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'dim_discrepancy_log'
ORDER BY ordinal_position;

-- Expected: discrepancy_id, customer_id, outcome_id, registration_id,
-- contract_id, action_name, discrepancy_type, expected_outcome,
-- actual_outcome, signal_confidence, threshold_used, detail,
-- resolved, resolved_at, created_at
