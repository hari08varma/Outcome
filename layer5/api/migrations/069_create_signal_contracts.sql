-- ══════════════════════════════════════════════════════════════
-- Migration 069: Create dim_signal_contracts
-- Part of: Real Outcome Signal Integration Phase 4 (schema prep)
-- This table stores per-action Signal Contracts that define how
-- to evaluate success for a specific action on a specific platform.
-- Phase 4 populates this via a management API. Phase 6's SDK reads
-- signal_contract from get-scores.ts to decide whether to use
-- the contract or fall back to Causal Graph Tracking.
-- Safe to run multiple times — uses IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dim_signal_contracts (
    contract_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which action is this contract for?
    action_id         UUID         NOT NULL
                                   REFERENCES dim_actions(action_id)
                                   ON DELETE CASCADE,

    -- Multi-tenancy scoping
    customer_id       UUID         NOT NULL,

    -- What platform/event does this contract listen for?
    -- e.g. platform='stripe', event_type='charge.refund.updated'
    event_type        VARCHAR(200) NOT NULL,
    platform          VARCHAR(100) NOT NULL,

    -- How to evaluate success from the incoming signal
    -- JSONPath or expression: e.g. '$.refund.status == "succeeded"'
    success_condition TEXT         NOT NULL,

    -- Optional: how to derive a 0-1 score from the signal payload
    -- e.g. '$.refund.amount / $.charge.amount'
    -- NULL = binary success/failure (score = 1.0 or 0.0)
    score_expression  TEXT         DEFAULT NULL,

    -- How much to trust this contract's signal (0.0-1.0)
    -- 1.0 = fully authoritative (e.g. Stripe webhook)
    -- 0.7 = partially trusted (e.g. inferred from HTTP body)
    confidence_weight FLOAT        NOT NULL DEFAULT 1.0,

    -- Whether this contract is currently active
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,

    -- Human-readable description of what this contract does
    description       TEXT         DEFAULT NULL,

    -- Who created this contract (customer admin, system, etc.)
    created_by        VARCHAR(200) DEFAULT NULL,

    -- Metadata
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Unique constraint ─────────────────────────────────────────
-- One active contract per action per customer per platform.
-- Prevents duplicate contracts for the same action/platform pair.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'dim_signal_contracts'
          AND constraint_name = 'uq_signal_contract_action_platform'
    ) THEN
        ALTER TABLE dim_signal_contracts
        ADD CONSTRAINT uq_signal_contract_action_platform
        UNIQUE (action_id, customer_id, platform);
    END IF;
END $$;

-- ── Indexes ────────────────────────────────────────────────────

-- Primary lookup: get contract for a specific action (used by get-scores.ts Phase 4)
CREATE INDEX IF NOT EXISTS idx_signal_contracts_action
ON dim_signal_contracts (action_id, customer_id)
WHERE is_active = TRUE;

-- Lookup by customer (used for contract management UI in Phase 7)
CREATE INDEX IF NOT EXISTS idx_signal_contracts_customer
ON dim_signal_contracts (customer_id)
WHERE is_active = TRUE;

-- ── Verification ────────────────────────────────────────────────
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'dim_signal_contracts'
ORDER BY ordinal_position;

-- Expected: 14 columns including contract_id, action_id, customer_id,
-- event_type, platform, success_condition, score_expression,
-- confidence_weight, is_active, description, created_by,
-- created_at, updated_at
