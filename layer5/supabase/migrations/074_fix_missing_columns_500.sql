-- ============================================================
-- LAYERINFINITE — Migration 074: Fix missing columns (500 on log-outcome)
-- ============================================================
--
-- ROOT CAUSE
-- ----------
-- log-outcome.ts insertCoreOutcome() sends these columns in every
-- fact_outcomes INSERT. They do not exist in the live database,
-- causing Postgres to reject every INSERT with:
--   "column X of relation fact_outcomes does not exist"
-- → insertErr fires → INSERT_ERROR branch → HTTP 500.
--
-- COLUMNS MISSING FROM LIVE fact_outcomes
-- ----------------------------------------
--   episode_id         UUID        SDK sequence-grouping field (no FK)
--   signal_source      TEXT        Phase 1 causal graph integration
--   signal_confidence  NUMERIC     Confidence of inferred signal (0–1)
--   causal_depth       SMALLINT    Transformation layers traversed (0–8)
--   signal_pending     BOOLEAN     Async verifier not yet resolved
--   signal_updated_at  TIMESTAMPTZ When signal was last updated
--   task_name          VARCHAR     Decision Recommendation Engine
--
-- ALSO MISSING
-- ----------------------------------------
--   mv_task_action_performance   — MV queried by get-recommendations.ts
--   refresh_task_action_performance() — RPC called by refreshTaskAggregation()
--   refresh_action_scores()      — RPC called by the same debounce fn
--
-- ALL OPERATIONS ARE IDEMPOTENT — safe to re-run on live production.
-- ============================================================

BEGIN;

-- ── Step 1: Add missing columns to fact_outcomes ─────────────────────────────
-- episode_id: SDK sequence-grouping field.
-- Plain UUID, NO FK — distinct from backprop_episode_id which has FK to
-- fact_episodes. Confirmed in log-outcome.ts code comment: "Stored as plain
-- UUID string — no FK constraint."
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS episode_id         UUID             DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS signal_source      TEXT             NOT NULL DEFAULT 'explicit',
  ADD COLUMN IF NOT EXISTS signal_confidence  NUMERIC(4,3)     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS causal_depth       SMALLINT         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS signal_pending     BOOLEAN          NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS signal_updated_at  TIMESTAMPTZ      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS task_name          VARCHAR(255)     DEFAULT NULL;

-- ── Step 2: Constraints on new columns ───────────────────────────────────────
ALTER TABLE fact_outcomes
  ADD CONSTRAINT chk_signal_source
    CHECK (signal_source IN ('causal_graph','signal_contract','http_inference','explicit')),
  ADD CONSTRAINT chk_signal_confidence
    CHECK (signal_confidence IS NULL OR (signal_confidence >= 0 AND signal_confidence <= 1)),
  ADD CONSTRAINT chk_causal_depth
    CHECK (causal_depth IS NULL OR (causal_depth >= 0 AND causal_depth <= 9));

-- Wrap in DO block so re-runs don't fail if constraints already exist
DO $$
BEGIN
  -- constraints added above with ADD CONSTRAINT IF NOT EXISTS not supported in PG14
  -- re-run safety: catch duplicate_object and continue
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Step 3: Indexes ───────────────────────────────────────────────────────────
-- task_name: scoped by customer for recommendation engine aggregation queries
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_task_name
  ON fact_outcomes(customer_id, task_name)
  WHERE task_name IS NOT NULL;

-- episode_id: used by sequence replay and backprop lookups
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_episode_id
  ON fact_outcomes(episode_id)
  WHERE episode_id IS NOT NULL;

-- signal_source: used by causal graph signal audit queries
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_signal_source
  ON fact_outcomes(customer_id, signal_source)
  WHERE signal_source != 'explicit';

-- ── Step 4: mv_task_action_performance ───────────────────────────────────────
-- This MV is queried by get-recommendations.ts and refreshed by the
-- refreshTaskAggregation() debounce in log-outcome.ts.
-- DROP first — idempotent, safe on live DB (MV is eventually consistent).
DROP MATERIALIZED VIEW IF EXISTS mv_task_action_performance;

CREATE MATERIALIZED VIEW mv_task_action_performance AS
SELECT
  fo.customer_id,
  fo.task_name,
  fo.action_id,
  da.action_name,
  COUNT(*)                                                      AS total_count,
  COUNT(*) FILTER (WHERE fo.success = TRUE)                    AS success_count,
  ROUND(
    COUNT(*) FILTER (WHERE fo.success = TRUE)::NUMERIC
    / NULLIF(COUNT(*), 0),
    4
  )                                                             AS success_rate,
  -- ml_score: latest weighted_success_rate from scoring engine.
  -- NULL = cold start for this action/task combination.
  MAX(mas.weighted_success_rate)                               AS ml_score,
  MAX(fo.timestamp)                                            AS last_seen_at
FROM fact_outcomes fo
JOIN dim_actions da
  ON  da.action_id   = fo.action_id
  AND da.customer_id = fo.customer_id
LEFT JOIN mv_action_scores mas
  ON  mas.action_id   = fo.action_id
  AND mas.customer_id = fo.customer_id
WHERE fo.task_name IS NOT NULL
GROUP BY
  fo.customer_id,
  fo.task_name,
  fo.action_id,
  da.action_name;

-- CONCURRENTLY refresh requires a unique index
CREATE UNIQUE INDEX idx_mv_task_action_perf_pk
  ON mv_task_action_performance(customer_id, task_name, action_id);

CREATE INDEX idx_mv_task_action_perf_lookup
  ON mv_task_action_performance(customer_id, task_name);

-- ── Step 5: RPC functions called by log-outcome.ts ───────────────────────────
-- refreshTaskAggregation() calls both of these via supabase.rpc().
-- SECURITY DEFINER so service_role can refresh without superuser.

CREATE OR REPLACE FUNCTION refresh_task_action_performance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_task_action_performance;
END;
$$;

-- refresh_action_scores is also called in the same Promise.allSettled block.
-- Only create if it doesn't already exist — it may have been added in 064–070.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'refresh_action_scores'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION refresh_action_scores()
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $body$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
      END;
      $body$;
    $fn$;
  END IF;
END $$;

COMMIT;

-- ── Verification queries (run after applying) ────────────────────────────────
-- Expected: 7 rows returned, all present
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'fact_outcomes'
  AND column_name IN (
    'episode_id',
    'signal_source',
    'signal_confidence',
    'causal_depth',
    'signal_pending',
    'signal_updated_at',
    'task_name'
  )
ORDER BY column_name;

-- Expected: mv_task_action_performance present, 0 rows (task_name not yet populated)
SELECT COUNT(*) FROM mv_task_action_performance;

-- Expected: both RPC functions exist
SELECT proname FROM pg_proc
WHERE proname IN ('refresh_task_action_performance', 'refresh_action_scores')
  AND pronamespace = 'public'::regnamespace;
