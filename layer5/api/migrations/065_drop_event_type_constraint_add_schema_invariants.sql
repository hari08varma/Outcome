-- ══════════════════════════════════════════════════════════════
-- Migration 065 — Drop rigid event_type constraint + add schema
--                 invariant checker function
-- ══════════════════════════════════════════════════════════════
--
-- PREVENTION RATIONALE
-- ────────────────────
-- Bug history (migrations 063/064) taught us two recurring patterns:
--
--   1. agent_trust_audit.event_type CHECK constraint
--      Every time a new event_type value is added to the RPC, a
--      migration is required or INSERT fails with 23514.
--      Fix: drop the CHECK constraint. The RPC update_trust_and_audit()
--      already controls which values are written — the constraint is
--      redundant and fragile. Application-level validation is enough.
--
--   2. mv_episode_patterns reading the wrong source table
--      The MV was built against fact_episodes (never populated).
--      Fix: migration 064 rewrote it. verify_schema_invariants() below
--      will detect this regression if it ever reappears.
--
-- ── Part A: Drop the rigid event_type CHECK constraint ────────
--
-- After this migration, any string can be stored in event_type.
-- Valid values are enforced by update_trust_and_audit() RPC only.
-- Known values: success | failure | failure_excluded_infrastructure
--               manual_override | status_change | recalibrated | updated

ALTER TABLE agent_trust_audit
    DROP CONSTRAINT IF EXISTS agent_trust_audit_event_type_check;

-- ── Part B: verify_schema_invariants() DB function ────────────
--
-- Called by /health/deep to detect schema regressions without
-- requiring access to pg_catalog from the application layer.
-- Returns: { pass: bool, failures: text[] }

CREATE OR REPLACE FUNCTION verify_schema_invariants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    failures text[] := '{}';
    fk_exists boolean;
    mv_source text;
BEGIN
    -- ── Invariant 1: action_sequences_episode_id_fkey must NOT exist ──
    -- This FK caused every upsertSequence() to fail with 23503.
    -- Dropped in migration 063. Must stay gone.
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'action_sequences_episode_id_fkey'
    ) INTO fk_exists;

    IF fk_exists THEN
        failures := array_append(failures,
            'action_sequences_episode_id_fkey exists — episode inserts will fail (FK 23503)');
    END IF;

    -- ── Invariant 2: mv_episode_patterns must query action_sequences ──
    -- If someone recreates the MV against fact_episodes (empty table),
    -- patterns will always return 0 rows.
    SELECT definition INTO mv_source
    FROM pg_matviews
    WHERE matviewname = 'mv_episode_patterns';

    IF mv_source IS NOT NULL AND mv_source NOT ILIKE '%action_sequences%' THEN
        failures := array_append(failures,
            'mv_episode_patterns does not read from action_sequences — patterns will be empty');
    END IF;

    -- ── Invariant 3: fact_outcomes.episode_id column must exist ───────
    -- Added in migration 063 to link outcomes to episodes.
    -- Without it, mv_episode_patterns join produces 0 rows.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'fact_outcomes' AND column_name = 'episode_id'
    ) THEN
        failures := array_append(failures,
            'fact_outcomes.episode_id column is missing — episode tracking broken');
    END IF;

    RETURN jsonb_build_object(
        'pass',     array_length(failures, 1) IS NULL,
        'failures', to_jsonb(failures)
    );
END;
$$;

-- ── Verify ─────────────────────────────────────────────────────
SELECT verify_schema_invariants();
