-- ============================================================================
-- Migration 117: Add resource cost tracking to fact_outcomes
--
-- Adds columns for tracking token usage, API call count, or compute cost
-- per outcome. Agent frameworks (LangChain, CrewAI) report
-- token_usage.total_tokens; this captures that signal for cost-per-outcome
-- analysis.
--
-- Columns:
--   resource_cost_units  — numeric value (e.g., 450 tokens, 3 API calls)
--   resource_cost_type   — enum: 'tokens', 'api_calls', 'compute_seconds'
--
-- Also adds avg_resource_cost to mv_action_scores for per-action cost insight.
-- ============================================================================

BEGIN;

-- ── Step 1: Add columns to fact_outcomes ─────────────────────────
ALTER TABLE fact_outcomes
    ADD COLUMN IF NOT EXISTS resource_cost_units numeric DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS resource_cost_type text DEFAULT NULL;

-- Constraint: only known cost types allowed
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_resource_cost_type'
    ) THEN
        ALTER TABLE fact_outcomes
            ADD CONSTRAINT chk_resource_cost_type
            CHECK (resource_cost_type IS NULL OR resource_cost_type IN ('tokens', 'api_calls', 'compute_seconds'));
    END IF;
END $$;

-- Constraint: cost_units must be non-negative when provided
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_resource_cost_units_nonneg'
    ) THEN
        ALTER TABLE fact_outcomes
            ADD CONSTRAINT chk_resource_cost_units_nonneg
            CHECK (resource_cost_units IS NULL OR resource_cost_units >= 0);
    END IF;
END $$;

-- ── Step 2: Partial index for cost analysis queries ──────────────
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_resource_cost
    ON fact_outcomes (action_id, resource_cost_units)
    WHERE resource_cost_units IS NOT NULL AND is_deleted = false;

COMMENT ON COLUMN fact_outcomes.resource_cost_units IS
    'Numeric cost value per outcome (e.g., token count, API call count, compute seconds).';
COMMENT ON COLUMN fact_outcomes.resource_cost_type IS
    'Type of cost: tokens, api_calls, or compute_seconds.';

COMMIT;
