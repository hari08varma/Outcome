-- ============================================================
-- LAYERINFINITE — Migration 063: Reconcile failed live steps
-- Covers failed legacy steps from deploy all:
--   015_update_mv_outcome_score.sql
--   033_sandbox_status.sql
--   045_remove_seed_data.sql
--   cold_start_priors.sql (seed script; skipped on live intentionally)
-- ============================================================

-- ------------------------------------------------------------
-- 015 compatibility: rebuild mv_action_scores with
-- outcome_score fallback AND latency columns (preserves 016 intent).
-- ------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_action_scores;

CREATE MATERIALIZED VIEW mv_action_scores AS
SELECT
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category,

  ROUND(
    AVG(COALESCE(fo.outcome_score, (fo.success::INT)::DOUBLE PRECISION))::NUMERIC,
    4
  ) AS raw_success_rate,

  ROUND(
      (
        SUM(
          COALESCE(fo.outcome_score, (fo.success::INT)::DOUBLE PRECISION) *
          EXP(-0.01 * EXTRACT(EPOCH FROM (NOW() - fo.timestamp)) / 3600.0)
        ) /
        NULLIF(
          SUM(EXP(-0.01 * EXTRACT(EPOCH FROM (NOW() - fo.timestamp)) / 3600.0)),
          0
        )
      )::NUMERIC,
    4
  ) AS weighted_success_rate,

  ROUND(
    COUNT(*)::NUMERIC / NULLIF(COUNT(*) + 10, 0),
    4
  ) AS confidence,

  COUNT(*) AS total_attempts,
  COUNT(*) FILTER (WHERE fo.success = TRUE) AS total_successes,
  COUNT(*) FILTER (WHERE fo.success = FALSE) AS total_failures,

  ROUND(
    (
      AVG(COALESCE(fo.outcome_score, (fo.success::INT)::DOUBLE PRECISION)) FILTER (
        WHERE fo.timestamp > NOW() - INTERVAL '7 days'
      ) -
      AVG(COALESCE(fo.outcome_score, (fo.success::INT)::DOUBLE PRECISION)) FILTER (
        WHERE fo.timestamp BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      )
    )::NUMERIC,
    4
  ) AS trend_delta,

  ROUND(
    AVG(COALESCE(fo.outcome_score, (fo.success::INT)::DOUBLE PRECISION)) FILTER (
      WHERE EXTRACT(HOUR FROM fo.timestamp AT TIME ZONE 'UTC') BETWEEN 9 AND 17
    )::NUMERIC,
    4
  ) AS business_hours_rate,

  ROUND(
    AVG(COALESCE(fo.outcome_score, (fo.success::INT)::DOUBLE PRECISION)) FILTER (
      WHERE EXTRACT(HOUR FROM fo.timestamp AT TIME ZONE 'UTC') NOT BETWEEN 9 AND 17
    )::NUMERIC,
    4
  ) AS after_hours_rate,

  MAX(fo.timestamp) AS last_outcome_at,
  NOW() AS view_refreshed_at,

  PERCENTILE_CONT(0.50) WITHIN GROUP
    (ORDER BY fo.response_time_ms)
    FILTER (WHERE fo.response_time_ms IS NOT NULL)
    AS latency_p50_ms,

  PERCENTILE_CONT(0.95) WITHIN GROUP
    (ORDER BY fo.response_time_ms)
    FILTER (WHERE fo.response_time_ms IS NOT NULL)
    AS latency_p95_ms,

  PERCENTILE_CONT(0.95) WITHIN GROUP
    (ORDER BY fo.response_time_ms)
    FILTER (
      WHERE fo.response_time_ms IS NOT NULL
      AND fo.timestamp < NOW() - INTERVAL '14 days'
      AND fo.timestamp >= NOW() - INTERVAL '30 days'
    ) AS latency_p95_baseline_ms,

  CASE
    WHEN PERCENTILE_CONT(0.95) WITHIN GROUP
         (ORDER BY fo.response_time_ms)
         FILTER (
           WHERE fo.response_time_ms IS NOT NULL
           AND fo.timestamp < NOW() - INTERVAL '14 days'
           AND fo.timestamp >= NOW() - INTERVAL '30 days'
         ) > 0
    THEN
      PERCENTILE_CONT(0.95) WITHIN GROUP
        (ORDER BY fo.response_time_ms)
        FILTER (
          WHERE fo.response_time_ms IS NOT NULL
          AND fo.timestamp >= NOW() - INTERVAL '14 days'
        )
      /
      PERCENTILE_CONT(0.95) WITHIN GROUP
        (ORDER BY fo.response_time_ms)
        FILTER (
          WHERE fo.response_time_ms IS NOT NULL
          AND fo.timestamp < NOW() - INTERVAL '14 days'
          AND fo.timestamp >= NOW() - INTERVAL '30 days'
        )
    ELSE NULL
  END AS latency_spike_ratio

FROM fact_outcomes fo
JOIN dim_actions da ON da.action_id = fo.action_id
WHERE fo.is_deleted = FALSE
  AND fo.is_synthetic = FALSE
GROUP BY fo.action_id, fo.context_id, fo.customer_id, da.action_name, da.action_category
HAVING COUNT(*) >= 1;

CREATE UNIQUE INDEX IF NOT EXISTS ux_action_scores_composite
  ON mv_action_scores(action_id, context_id, customer_id);


-- ------------------------------------------------------------
-- 033 compatibility: allow sandbox while preserving current
-- statuses observed on live ('new', 'degraded').
-- ------------------------------------------------------------
ALTER TABLE agent_trust_scores
  DROP CONSTRAINT IF EXISTS agent_trust_scores_trust_status_check;

ALTER TABLE agent_trust_scores
  ADD CONSTRAINT agent_trust_scores_trust_status_check
  CHECK (trust_status IN (
    'trusted',
    'probation',
    'sandbox',
    'suspended',
    'new',
    'degraded'
  ));

ALTER TABLE fact_decisions
  ADD COLUMN IF NOT EXISTS human_review_required BOOLEAN DEFAULT FALSE;


-- ------------------------------------------------------------
-- 045 compatibility: run cleanup conditionally depending on
-- schema shape (legacy/live divergence safe).
-- ------------------------------------------------------------
DELETE FROM dim_actions
WHERE created_at < '2026-03-10'
  AND customer_id IN (
    SELECT customer_id FROM dim_customers
    WHERE created_at < '2026-03-10'
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dim_institutional_knowledge'
      AND column_name = 'is_synthetic'
  ) THEN
    EXECUTE 'DELETE FROM dim_institutional_knowledge WHERE is_synthetic = true';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fact_outcomes'
      AND column_name = 'is_synthetic'
  ) THEN
    EXECUTE 'DELETE FROM fact_outcomes WHERE is_synthetic = true';
  END IF;
END $$;

DELETE FROM dim_agents
WHERE created_at < '2026-03-10'
  AND agent_name = 'default-agent'
  AND customer_id IN (
    SELECT customer_id FROM dim_customers
    WHERE created_at < '2026-03-10'
  );


-- ------------------------------------------------------------
-- Seed script on live: intentionally skipped.
-- cold_start_priors.sql is non-production demo data and should
-- not be re-applied to a live tenant DB.
-- ------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE 'cold_start_priors.sql skipped intentionally on live database';
END $$;
