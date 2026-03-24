-- ══════════════════════════════════════════════════════════════
-- Migration 068: Create dim_pending_signal_registrations
-- Part of: Real Outcome Signal Integration Phase 1
-- This table is used by Phase 4 async completion tracking.
-- No Phase 1 TypeScript touches this table — schema-only prep.
-- Safe to run multiple times — uses IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dim_pending_signal_registrations (
    registration_id  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which outcome is this registration for?
    outcome_id       UUID         NOT NULL
                                  REFERENCES fact_outcomes(outcome_id)
                                  ON DELETE CASCADE,

    -- Which agent and customer (for multi-tenancy scoping)
    agent_id         UUID         NOT NULL,
    customer_id      UUID         NOT NULL,

    -- What external event are we listening for?
    -- e.g. 'charge.refund.updated', 'deployment.status_changed'
    event_type       VARCHAR(200) NOT NULL,

    -- Which platform is the event coming from?
    -- e.g. 'stripe', 'github', 'pagerduty', 'custom'
    platform         VARCHAR(100) NOT NULL,

    -- Optional: platform-specific identifier to match the event
    -- e.g. Stripe refund ID 'rfnd_123', GitHub PR number '42'
    platform_ref_id  VARCHAR(500) DEFAULT NULL,

    -- JSONPath expression to extract success from webhook payload
    -- e.g. '$.refund.status == "succeeded"'
    -- NULL = Phase 4 will use the platform's semantic parser instead
    success_condition TEXT        DEFAULT NULL,

    -- JSONPath expression to extract score from webhook payload
    -- e.g. '$.refund.amount / $.refund.requested_amount'
    score_expression  TEXT        DEFAULT NULL,

    -- When should this registration expire if no webhook arrives?
    expiry_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '48 hours',

    -- Has this registration been resolved (webhook arrived)?
    resolved         BOOLEAN      NOT NULL DEFAULT FALSE,

    -- When was it resolved?
    resolved_at      TIMESTAMPTZ  DEFAULT NULL,

    -- What signal_source resolved it?
    -- e.g. 'stripe_webhook', 'inferred_llm', 'human_review'
    resolved_by      VARCHAR(100) DEFAULT NULL,

    -- Metadata
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Indexes ────────────────────────────────────────────────────

-- Lookup by outcome_id (used when updating an outcome's signal)
CREATE INDEX IF NOT EXISTS idx_pending_signal_by_outcome
ON dim_pending_signal_registrations (outcome_id)
WHERE resolved = FALSE;

-- Lookup by platform + event_type (used by signal-webhook.ts
-- when an external webhook arrives and needs to find the outcome)
CREATE INDEX IF NOT EXISTS idx_pending_signal_by_event
ON dim_pending_signal_registrations (platform, event_type)
WHERE resolved = FALSE;

-- Lookup for expired registrations (process-pending-outcomes job)
CREATE INDEX IF NOT EXISTS idx_pending_signal_expired
ON dim_pending_signal_registrations (expiry_at)
WHERE resolved = FALSE;

-- ── Verification ────────────────────────────────────────────────
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'dim_pending_signal_registrations'
ORDER BY ordinal_position;

-- Expected: 15 columns including registration_id, outcome_id,
-- agent_id, customer_id, event_type, platform, platform_ref_id,
-- success_condition, score_expression, expiry_at, resolved,
-- resolved_at, resolved_by, created_at, updated_at
