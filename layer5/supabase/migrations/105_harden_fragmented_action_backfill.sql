-- ============================================================================
-- Migration 105: Harden fragmented-action backfill safety and candidate logic
--
-- Why:
--   Migration 104 introduced audited dry-run/apply tooling, but production
--   rollout requires stronger invariants:
--   - Candidate detection must not depend on pre-existing alias rows.
--   - Apply path must exclude synthetic outcomes.
--   - Default row-move guard should be strict (10k) with explicit override.
--   - Backfill should write alias rows for drift monitoring.
--
-- This migration is forward-only and does not mutate data by itself.
-- ============================================================================

BEGIN;

-- Track explicit override intent in run audit rows.
ALTER TABLE action_fragmentation_backfill_runs
    ADD COLUMN IF NOT EXISTS force_override boolean NOT NULL DEFAULT false;

-- Tighten the default move budget for safer first-run operation.
ALTER TABLE action_fragmentation_backfill_runs
    ALTER COLUMN requested_max_outcomes SET DEFAULT 10000;

-- Runtime-consistent canonicalization helper for backfill matching.
CREATE OR REPLACE FUNCTION strip_action_version_suffixes(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    result text;
    prev text := '';
BEGIN
    IF p_name IS NULL THEN
        RETURN NULL;
    END IF;

    result := p_name;

    -- Match normalizeActionName() preprocessing in validate-action.ts.
    result := regexp_replace(result, '([a-z0-9])([A-Z])', '\1_\2', 'g');
    result := regexp_replace(result, '[-\s]+', '_', 'g');
    result := regexp_replace(result, '_+', '_', 'g');
    result := lower(result);
    result := regexp_replace(result, '^_+|_+$', '', 'g');

    WHILE prev IS DISTINCT FROM result AND length(result) > 3 LOOP
        prev := result;
        result := regexp_replace(result, '_v[0-9]+(_[0-9]+)?$', '');
        result := regexp_replace(result, '_(final|new|old|temp|bak|copy)$', '');
        result := regexp_replace(result, '_(test|prod|dev|staging)$', '');
        result := regexp_replace(result, '_(handler|fn|func|impl|helper)$', '');
        result := regexp_replace(result, '_+$', '', 'g');
    END LOOP;

    IF result = '' THEN
        RETURN p_name;
    END IF;

    RETURN result;
END;
$$;

-- Replace preview logic to discover candidates directly from dim_actions.
CREATE OR REPLACE FUNCTION preview_fragmented_action_merges(
    p_customer_id text DEFAULT NULL
)
RETURNS TABLE (
    customer_id text,
    raw_name text,
    canonical_name text,
    raw_action_id uuid,
    canonical_action_id uuid,
    outcome_rows bigint,
    decision_rows bigint
)
LANGUAGE sql
AS $$
WITH candidates AS (
    SELECT
        raw.customer_id::text AS customer_id,
        raw.action_name AS raw_name,
        strip_action_version_suffixes(raw.action_name) AS canonical_name,
        raw.action_id AS raw_action_id
    FROM dim_actions raw
    WHERE raw.is_active = true
      AND (p_customer_id IS NULL OR raw.customer_id::text = p_customer_id)
),
pairs AS (
    SELECT
        c.customer_id,
        c.raw_name,
        c.canonical_name,
        c.raw_action_id,
        canon.action_id AS canonical_action_id
    FROM candidates c
    JOIN dim_actions canon
      ON canon.customer_id::text = c.customer_id
     AND canon.action_name = c.canonical_name
     AND canon.is_active = true
    WHERE c.canonical_name <> c.raw_name
      AND c.raw_action_id <> canon.action_id
)
SELECT
    p.customer_id,
    p.raw_name,
    p.canonical_name,
    p.raw_action_id,
    p.canonical_action_id,
    (
        SELECT COUNT(*)
        FROM fact_outcomes fo
        WHERE fo.customer_id::text = p.customer_id
          AND fo.action_id = p.raw_action_id
          AND fo.is_deleted = false
          AND fo.is_synthetic = false
    ) AS outcome_rows,
    (
        SELECT COUNT(*)
        FROM fact_decisions fd
        JOIN dim_agents ag ON ag.agent_id = fd.agent_id
        WHERE ag.customer_id::text = p.customer_id
          AND fd.chosen_action_id = p.raw_action_id
    ) AS decision_rows
FROM pairs p
ORDER BY outcome_rows DESC, decision_rows DESC, p.customer_id, p.raw_name;
$$;

-- Replace function signature to add explicit force override control.
DROP FUNCTION IF EXISTS backfill_fragmented_actions(text, boolean, bigint);

CREATE OR REPLACE FUNCTION backfill_fragmented_actions(
    p_customer_id text DEFAULT NULL,
    p_dry_run boolean DEFAULT true,
    p_max_outcomes bigint DEFAULT 10000,
    p_force boolean DEFAULT false
)
RETURNS TABLE (
    run_id uuid,
    customer_id text,
    raw_name text,
    canonical_name text,
    outcome_rows bigint,
    decision_rows bigint,
    mode text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run_id uuid := gen_random_uuid();
    v_total_candidates integer := 0;
    v_total_outcomes bigint := 0;
    v_total_decisions bigint := 0;
    v_planned_outcomes bigint := 0;
    v_outcomes bigint := 0;
    v_decisions bigint := 0;
    v_trigger_disabled boolean := false;
    rec RECORD;
BEGIN
    IF p_max_outcomes <= 0 THEN
        RAISE EXCEPTION '[backfill] p_max_outcomes must be > 0. received=%', p_max_outcomes;
    END IF;

    INSERT INTO action_fragmentation_backfill_runs (
        run_id,
        requested_customer_id,
        dry_run,
        requested_max_outcomes,
        force_override,
        status
    ) VALUES (
        v_run_id,
        p_customer_id,
        p_dry_run,
        p_max_outcomes,
        p_force,
        'running'
    );

    BEGIN
        SELECT COALESCE(SUM(pf.outcome_rows), 0)
        INTO v_planned_outcomes
        FROM preview_fragmented_action_merges(p_customer_id) pf;

        IF NOT p_dry_run AND v_planned_outcomes > p_max_outcomes AND NOT p_force THEN
            RAISE EXCEPTION
                '[backfill] Planned outcome rewrites (%) exceed p_max_outcomes (%). Re-run with p_force=true after dry-run review.',
                v_planned_outcomes,
                p_max_outcomes;
        END IF;

        IF NOT p_dry_run THEN
            -- Controlled one-time rewrite path for action_id migration only.
            IF EXISTS (
                SELECT 1
                FROM pg_trigger
                WHERE tgname = 'enforce_append_only'
                  AND tgrelid = 'fact_outcomes'::regclass
                  AND NOT tgisinternal
            ) THEN
                EXECUTE 'ALTER TABLE fact_outcomes DISABLE TRIGGER enforce_append_only';
                v_trigger_disabled := true;
            END IF;
        END IF;

        FOR rec IN
            SELECT *
            FROM preview_fragmented_action_merges(p_customer_id)
        LOOP
            v_total_candidates := v_total_candidates + 1;

            IF p_dry_run THEN
                v_outcomes := rec.outcome_rows;
                v_decisions := rec.decision_rows;

                INSERT INTO action_fragmentation_backfill_details (
                    run_id,
                    customer_id,
                    raw_name,
                    canonical_name,
                    raw_action_id,
                    canonical_action_id,
                    outcome_rows,
                    decision_rows,
                    mode
                ) VALUES (
                    v_run_id,
                    rec.customer_id,
                    rec.raw_name,
                    rec.canonical_name,
                    rec.raw_action_id,
                    rec.canonical_action_id,
                    v_outcomes,
                    v_decisions,
                    'dry_run'
                );

                v_total_outcomes := v_total_outcomes + COALESCE(v_outcomes, 0);
                v_total_decisions := v_total_decisions + COALESCE(v_decisions, 0);

                RETURN QUERY SELECT
                    v_run_id,
                    rec.customer_id,
                    rec.raw_name,
                    rec.canonical_name,
                    v_outcomes,
                    v_decisions,
                    'dry_run'::text;
            ELSE
                IF v_total_outcomes + COALESCE(rec.outcome_rows, 0) > p_max_outcomes AND NOT p_force THEN
                    RAISE EXCEPTION
                        '[backfill] Runtime row gate exceeded while processing %. Set p_force=true to override after review.',
                        rec.raw_name;
                END IF;

                v_outcomes := 0;
                v_decisions := 0;

                UPDATE fact_outcomes fo
                   SET action_id = rec.canonical_action_id
                 WHERE fo.customer_id::text = rec.customer_id
                   AND fo.action_id = rec.raw_action_id
                   AND fo.is_deleted = false
                   AND fo.is_synthetic = false;
                GET DIAGNOSTICS v_outcomes = ROW_COUNT;

                UPDATE fact_decisions fd
                   SET chosen_action_id = rec.canonical_action_id,
                       chosen_action_name = rec.canonical_name
                  FROM dim_agents ag
                 WHERE fd.agent_id = ag.agent_id
                   AND ag.customer_id::text = rec.customer_id
                   AND fd.chosen_action_id = rec.raw_action_id;
                GET DIAGNOSTICS v_decisions = ROW_COUNT;

                -- Prevent future writes to fragmented aliases via stale action ids.
                UPDATE dim_actions da
                   SET is_active = false
                 WHERE da.customer_id::text = rec.customer_id
                   AND da.action_id = rec.raw_action_id
                   AND da.is_active = true;

                -- Persist alias audit rows so drift detector can monitor these merges.
                INSERT INTO dim_action_aliases (
                    canonical_name,
                    raw_name,
                    customer_id,
                    merge_reason,
                    merge_confidence,
                    similarity,
                    needs_review
                ) VALUES (
                    rec.canonical_name,
                    rec.raw_name,
                    rec.customer_id,
                    'version_strip_backfill',
                    1.000,
                    NULL,
                    false
                )
                ON CONFLICT (raw_name, customer_id)
                DO UPDATE SET
                    canonical_name = EXCLUDED.canonical_name,
                    merge_reason = EXCLUDED.merge_reason,
                    merge_confidence = GREATEST(dim_action_aliases.merge_confidence, EXCLUDED.merge_confidence),
                    similarity = COALESCE(dim_action_aliases.similarity, EXCLUDED.similarity);

                INSERT INTO action_fragmentation_backfill_details (
                    run_id,
                    customer_id,
                    raw_name,
                    canonical_name,
                    raw_action_id,
                    canonical_action_id,
                    outcome_rows,
                    decision_rows,
                    mode
                ) VALUES (
                    v_run_id,
                    rec.customer_id,
                    rec.raw_name,
                    rec.canonical_name,
                    rec.raw_action_id,
                    rec.canonical_action_id,
                    v_outcomes,
                    v_decisions,
                    'applied'
                );

                v_total_outcomes := v_total_outcomes + COALESCE(v_outcomes, 0);
                v_total_decisions := v_total_decisions + COALESCE(v_decisions, 0);

                RETURN QUERY SELECT
                    v_run_id,
                    rec.customer_id,
                    rec.raw_name,
                    rec.canonical_name,
                    v_outcomes,
                    v_decisions,
                    'applied'::text;
            END IF;
        END LOOP;

        IF v_trigger_disabled THEN
            EXECUTE 'ALTER TABLE fact_outcomes ENABLE TRIGGER enforce_append_only';
            v_trigger_disabled := false;
        END IF;

        -- Refresh recommendation views after apply so downstream reads converge quickly.
        IF NOT p_dry_run THEN
            IF EXISTS (
                SELECT 1
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.proname = 'refresh_task_action_performance'
                  AND n.nspname = 'public'
            ) THEN
                PERFORM refresh_task_action_performance();
            END IF;
        END IF;

        UPDATE action_fragmentation_backfill_runs
           SET status = CASE WHEN p_dry_run THEN 'dry_run' ELSE 'completed' END,
               total_candidates = v_total_candidates,
               total_outcomes_updated = v_total_outcomes,
               total_decisions_updated = v_total_decisions,
               finished_at = now()
         WHERE run_id = v_run_id;

    EXCEPTION WHEN OTHERS THEN
        IF v_trigger_disabled THEN
            EXECUTE 'ALTER TABLE fact_outcomes ENABLE TRIGGER enforce_append_only';
            v_trigger_disabled := false;
        END IF;

        UPDATE action_fragmentation_backfill_runs
           SET status = 'failed',
               total_candidates = v_total_candidates,
               total_outcomes_updated = v_total_outcomes,
               total_decisions_updated = v_total_decisions,
               error_message = SQLERRM,
               finished_at = now()
         WHERE run_id = v_run_id;

        RAISE;
    END;
END;
$$;

COMMENT ON FUNCTION strip_action_version_suffixes(text) IS
    'Canonicalizes action names for backfill pairing, matching runtime normalization suffix stripping rules.';

COMMENT ON FUNCTION preview_fragmented_action_merges(text) IS
    'Read-only preview of active raw->canonical merges detected directly from dim_actions suffix fragmentation.';

COMMENT ON FUNCTION backfill_fragmented_actions(text, boolean, bigint, boolean) IS
    'Audited fragmented-action backfill. Dry-run by default; apply mode rewrites action ids and enforces a strict row gate unless p_force=true.';

COMMIT;

-- ── Verification / Operations ────────────────────────────────────
-- 1) Preview candidates (read-only):
--    SELECT * FROM preview_fragmented_action_merges(NULL) LIMIT 100;
--
-- 2) Dry-run with strict default gate:
--    SELECT * FROM backfill_fragmented_actions(NULL, true, 10000, false);
--
-- 3) Apply (safe default):
--    SELECT * FROM backfill_fragmented_actions(NULL, false, 10000, false);
--
-- 4) Apply with explicit override (after dry-run review):
--    SELECT * FROM backfill_fragmented_actions(NULL, false, 10000, true);