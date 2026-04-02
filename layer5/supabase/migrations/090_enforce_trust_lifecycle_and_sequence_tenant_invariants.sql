-- Migration 090 — Enforce canonical trust lifecycle + tenant sequence invariants
--
-- WHY:
-- 1) Canonical trust statuses are now: trusted | probation | sandbox | suspended | new.
--    Legacy 'degraded' rows are normalized to 'sandbox' and DB CHECK is tightened.
-- 2) verify_schema_invariants() is extended to detect tenant-scope regressions for
--    action_sequences and mv_sequence_scores (customer_id presence and NOT NULL where required).

BEGIN;

-- Normalize legacy trust status rows before tightening the CHECK constraint.
UPDATE agent_trust_scores
SET trust_status = 'sandbox',
    suspension_reason = COALESCE(suspension_reason, 'legacy_degraded_migrated')
WHERE trust_status = 'degraded';

ALTER TABLE agent_trust_scores
    DROP CONSTRAINT IF EXISTS agent_trust_scores_trust_status_check;

ALTER TABLE agent_trust_scores
    ADD CONSTRAINT agent_trust_scores_trust_status_check
    CHECK (trust_status IN ('trusted', 'probation', 'sandbox', 'suspended', 'new'));

CREATE OR REPLACE FUNCTION verify_schema_invariants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    failures text[] := '{}';
    fk_exists boolean;
    mv_source text;
    constraint_exists boolean;
    seq_customer_exists boolean;
    seq_customer_not_null boolean;
    mv_seq_customer_exists boolean;
BEGIN
    -- Invariant 1: action_sequences_episode_id_fkey must NOT exist
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'action_sequences_episode_id_fkey'
    ) INTO fk_exists;
    IF fk_exists THEN
        failures := array_append(failures,
            'action_sequences_episode_id_fkey exists — episode inserts will fail (FK 23503)');
    END IF;

    -- Invariant 2: mv_episode_patterns must query action_sequences
    SELECT definition INTO mv_source
    FROM pg_matviews
    WHERE matviewname = 'mv_episode_patterns';
    IF mv_source IS NOT NULL AND mv_source NOT ILIKE '%action_sequences%' THEN
        failures := array_append(failures,
            'mv_episode_patterns does not read from action_sequences — patterns will be empty');
    END IF;

    -- Invariant 3: fact_outcomes.episode_id column must exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'fact_outcomes'
          AND a.attname = 'episode_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
    ) THEN
        failures := array_append(failures,
            'fact_outcomes.episode_id column is missing — episode tracking broken');
    END IF;

    -- Invariant 4: dim_contexts unique constraint must exist
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'dim_contexts_customer_issue_env_unique'
          AND contype = 'u'
    ) INTO constraint_exists;
    IF NOT constraint_exists THEN
        failures := array_append(failures,
            'dim_contexts_customer_issue_env_unique constraint missing — resolveContextId upsert will fail with Postgres 42P10');
    END IF;

    -- Invariant 5: action_sequences.customer_id must exist
    SELECT EXISTS (
        SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'action_sequences'
          AND a.attname = 'customer_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
    ) INTO seq_customer_exists;
    IF NOT seq_customer_exists THEN
        failures := array_append(failures,
            'action_sequences.customer_id column missing — tenant sequence isolation broken');
    END IF;

    -- Invariant 6: action_sequences.customer_id must be NOT NULL
    SELECT EXISTS (
        SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'action_sequences'
          AND a.attname = 'customer_id'
          AND a.attnotnull
          AND a.attnum > 0
          AND NOT a.attisdropped
    ) INTO seq_customer_not_null;
    IF NOT seq_customer_not_null THEN
        failures := array_append(failures,
            'action_sequences.customer_id is nullable — tenant sequence isolation can degrade');
    END IF;

    -- Invariant 7: mv_sequence_scores must expose customer_id
    SELECT EXISTS (
        SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'mv_sequence_scores'
          AND a.attname = 'customer_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
    ) INTO mv_seq_customer_exists;
    IF NOT mv_seq_customer_exists THEN
        failures := array_append(failures,
            'mv_sequence_scores.customer_id missing — tier1 simulations may leak across tenants');
    END IF;

    RETURN jsonb_build_object(
        'pass',     array_length(failures, 1) IS NULL,
        'failures', to_jsonb(failures)
    );
END;
$$;

COMMIT;

SELECT verify_schema_invariants();
