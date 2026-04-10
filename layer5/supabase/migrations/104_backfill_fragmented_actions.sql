-- ============================================================================
-- Migration 104: Backfill fragmented action identifiers to canonical targets
--
-- Why:
--   After normalization tightening (e.g. *_v2 -> canonical), historical rows
--   may still be attached to legacy raw action IDs. This fragments learning
--   and weakens recommendation quality.
--
-- What this migration provides:
--   1) Preview function to list candidate raw->canonical merges.
--   2) Audited backfill function with DRY RUN mode (default).
--   3) Controlled APPLY mode that temporarily disables append-only trigger
--      only for action_id rewrites, then re-enables it in all paths.
--
-- Safety:
--   - No automatic data mutation is executed during migration.
--   - APPLY is opt-in via function argument p_dry_run=false.
--   - Every run is logged in audit tables.
-- ============================================================================

BEGIN;

-- ── Step 1: Audit tables ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS action_fragmentation_backfill_runs (
    run_id                  uuid PRIMARY KEY,
    requested_customer_id   text,
    dry_run                 boolean NOT NULL DEFAULT true,
    requested_max_outcomes  bigint NOT NULL DEFAULT 500000,
    status                  text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'dry_run', 'completed', 'failed')),
    total_candidates        integer NOT NULL DEFAULT 0,
    total_outcomes_updated  bigint NOT NULL DEFAULT 0,
    total_decisions_updated bigint NOT NULL DEFAULT 0,
    error_message           text,
    started_at              timestamptz NOT NULL DEFAULT now(),
    finished_at             timestamptz
);

CREATE TABLE IF NOT EXISTS action_fragmentation_backfill_details (
    detail_id            bigserial PRIMARY KEY,
    run_id               uuid NOT NULL
        REFERENCES action_fragmentation_backfill_runs(run_id) ON DELETE CASCADE,
    customer_id          text NOT NULL,
    raw_name             text NOT NULL,
    canonical_name       text NOT NULL,
    raw_action_id        uuid NOT NULL,
    canonical_action_id  uuid NOT NULL,
    outcome_rows         bigint NOT NULL DEFAULT 0,
    decision_rows        bigint NOT NULL DEFAULT 0,
    mode                 text NOT NULL
        CHECK (mode IN ('dry_run', 'applied', 'skipped_limit')),
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_fragmentation_backfill_details_run
    ON action_fragmentation_backfill_details (run_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_action_fragmentation_backfill_runs_status
    ON action_fragmentation_backfill_runs (status, started_at DESC);

-- ── Step 2: Preview function (read-only) ────────────────────────
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
WITH alias_pairs AS (
    SELECT
        a.customer_id,
        a.raw_name,
        a.canonical_name,
        raw.action_id AS raw_action_id,
        canon.action_id AS canonical_action_id
    FROM dim_action_aliases a
    JOIN dim_actions raw
      ON raw.customer_id::text = a.customer_id
     AND raw.action_name = a.raw_name
    JOIN dim_actions canon
      ON canon.customer_id::text = a.customer_id
     AND canon.action_name = a.canonical_name
    WHERE raw.action_id <> canon.action_id
      AND (p_customer_id IS NULL OR a.customer_id = p_customer_id)
)
SELECT
    ap.customer_id,
    ap.raw_name,
    ap.canonical_name,
    ap.raw_action_id,
    ap.canonical_action_id,
    (
        SELECT COUNT(*)
        FROM fact_outcomes fo
        WHERE fo.customer_id::text = ap.customer_id
          AND fo.action_id = ap.raw_action_id
          AND fo.is_deleted = false
    ) AS outcome_rows,
    (
        SELECT COUNT(*)
        FROM fact_decisions fd
        JOIN dim_agents ag ON ag.agent_id = fd.agent_id
        WHERE ag.customer_id::text = ap.customer_id
          AND fd.chosen_action_id = ap.raw_action_id
    ) AS decision_rows
FROM alias_pairs ap
ORDER BY outcome_rows DESC, decision_rows DESC, ap.customer_id, ap.raw_name;
$$;

-- ── Step 3: Audited apply function (dry-run by default) ─────────
CREATE OR REPLACE FUNCTION backfill_fragmented_actions(
    p_customer_id text DEFAULT NULL,
    p_dry_run boolean DEFAULT true,
    p_max_outcomes bigint DEFAULT 500000
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
AS $$
DECLARE
    v_run_id uuid := gen_random_uuid();
    v_total_candidates integer := 0;
    v_total_outcomes bigint := 0;
    v_total_decisions bigint := 0;
    v_outcomes bigint := 0;
    v_decisions bigint := 0;
    v_trigger_disabled boolean := false;
    rec RECORD;
BEGIN
    INSERT INTO action_fragmentation_backfill_runs (
        run_id,
        requested_customer_id,
        dry_run,
        requested_max_outcomes,
        status
    ) VALUES (
        v_run_id,
        p_customer_id,
        p_dry_run,
        p_max_outcomes,
        'running'
    );

    BEGIN
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
                IF v_total_outcomes + COALESCE(rec.outcome_rows, 0) > p_max_outcomes THEN
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
                        0,
                        0,
                        'skipped_limit'
                    );

                    RETURN QUERY SELECT
                        v_run_id,
                        rec.customer_id,
                        rec.raw_name,
                        rec.canonical_name,
                        0::bigint,
                        0::bigint,
                        'skipped_limit'::text;

                    CONTINUE;
                END IF;

                v_outcomes := 0;
                v_decisions := 0;

                UPDATE fact_outcomes fo
                   SET action_id = rec.canonical_action_id
                 WHERE fo.customer_id::text = rec.customer_id
                   AND fo.action_id = rec.raw_action_id
                   AND fo.is_deleted = false;
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

COMMENT ON FUNCTION preview_fragmented_action_merges(text) IS
    'Read-only preview of raw->canonical action merges detected from dim_action_aliases.';

COMMENT ON FUNCTION backfill_fragmented_actions(text, boolean, bigint) IS
    'Audited fragmented-action backfill. Dry-run by default; apply mode rewrites fact_outcomes.action_id and fact_decisions.chosen_action_id.';

COMMIT;

-- ── Verification / Operations ────────────────────────────────────
-- 1) Preview candidates (read-only):
--    SELECT * FROM preview_fragmented_action_merges(NULL) LIMIT 100;
--
-- 2) Dry-run with audit rows:
--    SELECT * FROM backfill_fragmented_actions(NULL, true, 500000);
--
-- 3) Apply (explicit):
--    SELECT * FROM backfill_fragmented_actions(NULL, false, 500000);
--
-- 4) Inspect run history:
--    SELECT * FROM action_fragmentation_backfill_runs ORDER BY started_at DESC LIMIT 20;
