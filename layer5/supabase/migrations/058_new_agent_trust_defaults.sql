-- ============================================================
-- LAYERINFINITE — Migration 058: Fix new agent trust defaults
-- ============================================================
-- Removes the fake 0.70/TRUSTED default for new agents.
-- New agents now start with trust_score = NULL and
-- trust_status = 'new' (zero outcomes = no signal yet).
-- The dashboard shows an onboarding empty state instead of
-- a misleading "TRUSTED 0.70" display.
-- ============================================================

-- Step 1: Make trust_score nullable (was NOT NULL DEFAULT 0.7)
ALTER TABLE agent_trust_scores
    ALTER COLUMN trust_score DROP NOT NULL;

ALTER TABLE agent_trust_scores
    ALTER COLUMN trust_score SET DEFAULT NULL;

-- Step 2: Expand trust_status CHECK constraint to include 'new' and 'degraded'.
-- 'new'     = zero outcomes, no signal yet (added here)
-- 'degraded' = used by upsertLiveTrustScore() but was missing from constraint
-- Existing: trusted | probation | sandbox | suspended (from migration 033)
ALTER TABLE agent_trust_scores
    DROP CONSTRAINT IF EXISTS agent_trust_scores_trust_status_check;

ALTER TABLE agent_trust_scores
    ADD CONSTRAINT agent_trust_scores_trust_status_check
    CHECK (trust_status IN ('trusted', 'probation', 'sandbox', 'suspended', 'new', 'degraded'));

-- Step 3: Update the trigger function to insert explicit NULL values.
-- Previously: INSERT INTO agent_trust_scores (agent_id) VALUES (NEW.agent_id)
-- → column defaults applied: trust_score=0.7, trust_status='trusted'
-- Now: explicit NULL/new so no default leaks through.
CREATE OR REPLACE FUNCTION fn_init_agent_trust()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO agent_trust_scores (
        agent_id,
        trust_score,
        trust_status,
        consecutive_failures,
        total_decisions,
        correct_decisions
    )
    VALUES (NEW.agent_id, NULL, 'new', 0, 0, 0)
    ON CONFLICT (agent_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Backfill existing zero-outcome agents that incorrectly show 0.70/trusted.
-- Only resets rows with total_decisions = 0 (no real outcomes logged).
UPDATE agent_trust_scores
SET
    trust_score  = NULL,
    trust_status = 'new'
WHERE
    total_decisions = 0
    AND (trust_score IS NULL OR trust_score = 0.7);

-- Step 5: Add integrity constraint — a non-null trust_score requires at least
-- one recorded decision. Prevents any future code path from writing a score
-- without a corresponding outcome.
ALTER TABLE agent_trust_scores
    DROP CONSTRAINT IF EXISTS chk_trust_score_needs_decisions;

ALTER TABLE agent_trust_scores
    ADD CONSTRAINT chk_trust_score_needs_decisions CHECK (
        (trust_score IS NULL AND total_decisions = 0)
        OR
        (trust_score IS NOT NULL AND total_decisions > 0)
    );

-- Verification (run after deploying):
-- SELECT agent_id, trust_score, trust_status, total_decisions
-- FROM agent_trust_scores
-- WHERE total_decisions = 0;
-- Expected: trust_score = NULL, trust_status = 'new' for all rows.
