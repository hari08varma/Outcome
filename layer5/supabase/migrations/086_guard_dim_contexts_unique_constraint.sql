-- Migration 086 — Guard: ensure dim_contexts unique constraint exists
-- 
-- WHY: resolveContextId() in routes/log-outcome.ts uses upsert with
-- onConflict: 'customer_id,issue_type,environment'. Postgres requires a
-- UNIQUE constraint or unique index on exactly these columns. This constraint
-- was added in layer5/supabase/migrations/044 but was never backfilled into
-- layer5/api/migrations/, leaving any environment bootstrapped from api/migrations
-- alone (CI, local, new Railway deploys) with a broken upsert (Postgres 42P10).
--
-- PostgreSQL does not support ADD CONSTRAINT IF NOT EXISTS, so guard it
-- with a catalog check.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'dim_contexts_customer_issue_env_unique'
          AND conrelid = 'dim_contexts'::regclass
    ) THEN
        ALTER TABLE dim_contexts
            ADD CONSTRAINT dim_contexts_customer_issue_env_unique
            UNIQUE (customer_id, issue_type, environment);
    END IF;
END
$$;

-- Also add to verify_schema_invariants() so /health/deep will catch future regressions.
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
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'fact_outcomes' AND column_name = 'episode_id'
    ) THEN
        failures := array_append(failures,
            'fact_outcomes.episode_id column is missing — episode tracking broken');
    END IF;

    -- Invariant 4 (NEW): dim_contexts unique constraint must exist
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'dim_contexts_customer_issue_env_unique'
          AND contype = 'u'
    ) INTO constraint_exists;
    IF NOT constraint_exists THEN
        failures := array_append(failures,
            'dim_contexts_customer_issue_env_unique constraint missing — resolveContextId upsert will fail with Postgres 42P10');
    END IF;

    RETURN jsonb_build_object(
        'pass',     array_length(failures, 1) IS NULL,
        'failures', to_jsonb(failures)
    );
END;
$$;

SELECT verify_schema_invariants();
