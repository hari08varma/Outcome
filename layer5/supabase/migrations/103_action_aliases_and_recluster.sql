-- ══════════════════════════════════════════════════════════════
-- LAYERINFINITE — Migration 103: Action Alias Registry + Re-clustering
-- ══════════════════════════════════════════════════════════════
-- Adds infrastructure for the Noise & Fragmentation fix (Fix 2):
--
-- 1. dim_action_aliases — Merge audit log. Records every normalization
--    that maps a developer-sent action name to a canonical form.
--    Inspectable, reversible, queryable.
--
-- 2. recluster_action_aliases() — Nightly batch function that checks
--    for temporal drift: if a canonical action's success_rate diverges
--    >15% from what the aliased raw name produced before merge,
--    the alias is flagged for human review (needs_review=true).
--
-- Safety:
--   - Fully idempotent: all DDL uses IF NOT EXISTS / DO blocks,
--     and cron schedule registration is guarded + replaced atomically.
--   - Backward compatible: all columns are nullable or defaulted.
--   - No destructive operations.
-- ══════════════════════════════════════════════════════════════

-- ── Step 1: dim_action_aliases table ─────────────────────────
CREATE TABLE IF NOT EXISTS dim_action_aliases (
    alias_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name   text NOT NULL,       -- the normalized form (stored in dim_actions)
    raw_name         text NOT NULL,       -- what the developer actually sent
    customer_id      text NOT NULL,
    similarity       numeric(4,3),        -- null for deterministic rule-based merges
    merge_reason     text NOT NULL,       -- 'version_strip' | 'camel_normalize' | 'normalization'
    merge_confidence numeric(4,3) NOT NULL DEFAULT 1.000,
    needs_review     boolean NOT NULL DEFAULT false,
    review_reason    text,                -- why flagged (e.g. 'success_rate_drift_18%')
    created_at       timestamptz NOT NULL DEFAULT now(),
    reviewed_at      timestamptz,
    UNIQUE (raw_name, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_dim_action_aliases_canonical
    ON dim_action_aliases (canonical_name, customer_id);

CREATE INDEX IF NOT EXISTS idx_dim_action_aliases_needs_review
    ON dim_action_aliases (needs_review)
    WHERE needs_review = true;

-- ── Step 2: RLS (service role bypasses — API uses service key) ─
ALTER TABLE dim_action_aliases ENABLE ROW LEVEL SECURITY;

-- ── Step 3: Re-clustering function ───────────────────────────
-- Runs nightly. For each version_strip alias with enough data,
-- compares canonical vs raw success_rate. Flags drift >15%.
CREATE OR REPLACE FUNCTION recluster_action_aliases()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    alias_rec RECORD;
    canonical_rate numeric;
    alias_outcome_count int;
    alias_success_count int;
    alias_rate numeric;
    drift numeric;
BEGIN
    FOR alias_rec IN
        SELECT
            a.alias_id,
            a.canonical_name,
            a.raw_name,
            a.customer_id,
            a.created_at AS alias_created
        FROM dim_action_aliases a
        WHERE a.merge_reason = 'version_strip'
          AND a.needs_review = false
    LOOP
        -- Get canonical action's current success rate.
        -- Use a deterministic weighted aggregate across all task rows,
        -- rather than LIMIT 1 from an arbitrary row.
        SELECT
            COALESCE(
                SUM(
                    (COALESCE(tap.ml_score, tap.success_rate)::numeric)
                    * (GREATEST(tap.total_count, 1)::numeric)
                )
                /
                NULLIF(SUM(GREATEST(tap.total_count, 1)::numeric), 0),
                0.5
            )
        INTO canonical_rate
        FROM mv_task_action_performance tap
        WHERE tap.action_name = alias_rec.canonical_name
          AND tap.customer_id::text = alias_rec.customer_id
          AND tap.agent_id <> '00000000-0000-0000-0000-000000000000'::uuid;

        -- Count outcomes for the raw (aliased) name BEFORE the alias was created
        SELECT
            COUNT(*),
            COUNT(*) FILTER (WHERE fo.success = true)
        INTO alias_outcome_count, alias_success_count
        FROM fact_outcomes fo
        JOIN dim_actions da ON da.action_id = fo.action_id
        WHERE da.action_name = alias_rec.raw_name
                    AND da.customer_id::text = alias_rec.customer_id
                    AND fo.is_deleted = false
                    AND fo.is_synthetic = false
          AND fo.timestamp < alias_rec.alias_created;

        -- Need at least 20 outcomes to be meaningful
        IF alias_outcome_count < 20 THEN
            CONTINUE;
        END IF;

        alias_rate := alias_success_count::numeric / alias_outcome_count;
        drift := ABS(canonical_rate - alias_rate);

        IF drift > 0.15 THEN
            UPDATE dim_action_aliases
            SET needs_review = true,
                review_reason = format(
                    'success_rate_drift_%.0f%%: canonical=%.2f, pre_merge_raw=%.2f',
                    drift * 100, canonical_rate, alias_rate
                )
            WHERE alias_id = alias_rec.alias_id;
        END IF;
    END LOOP;
END;
$$;

-- ── Step 4: Schedule nightly cron (after MV refresh at 03:00) ─
-- MV refreshes run at 03:00 UTC (migration 043/047).
-- Re-clustering runs at 04:00 UTC to use fresh MV data.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        -- Replace any prior schedule to keep this migration re-runnable.
        PERFORM cron.unschedule('recluster-action-aliases')
        WHERE EXISTS (
            SELECT 1
            FROM cron.job
            WHERE jobname = 'recluster-action-aliases'
        );

        PERFORM cron.schedule(
            'recluster-action-aliases',
            '0 4 * * *',
            'SELECT recluster_action_aliases()'
        );
    ELSE
        RAISE NOTICE 'pg_cron extension not installed; skipping recluster-action-aliases schedule.';
    END IF;
END $$;

-- ── Verification ──────────────────────────────────────────────
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'dim_action_aliases'
ORDER BY ordinal_position;

COMMENT ON TABLE dim_action_aliases IS
    'Merge audit log for action name normalization. '
    'Records every developer-sent raw_name → canonical_name mapping. '
    'Inspectable, reversible. needs_review flagged by nightly drift detection.';
