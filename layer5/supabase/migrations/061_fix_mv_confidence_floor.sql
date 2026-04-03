-- ============================================================
-- LAYERINFINITE — Migration 061: Fix mv_action_scores confidence floor
-- ============================================================
-- Fixes:
--   1) confidence denominator n+10 -> n+5
--   2) trend_delta NULL -> 0.0 via COALESCE wrapper
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS mv_action_scores CASCADE;

CREATE MATERIALIZED VIEW mv_action_scores AS
SELECT
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category,
  -- Raw success rate (unweighted)
  ROUND(
    AVG(fo.success::INT)::NUMERIC,
    4
  ) AS raw_success_rate,
  -- Recency-weighted success rate
  -- More recent outcomes get exponentially higher weight
  -- weight = exp(-0.01 * hours_ago) where hours_ago = age in hours
  ROUND(
    SUM(
      fo.success::INT *
      EXP(-0.01 * EXTRACT(EPOCH FROM (NOW() - fo.timestamp)) / 3600.0)
    ) /
    NULLIF(
      SUM(
        EXP(-0.01 * EXTRACT(EPOCH FROM (NOW() - fo.timestamp)) / 3600.0)
      ),
      0
    )::NUMERIC,
    4
  ) AS weighted_success_rate,
  -- Confidence: based on sample count using Wilson score lower bound approximation
  -- confidence = n / (n + 5) — ranges from ~0 (n=0) to 1.0 (n=∞)
  ROUND(
    COUNT(*)::NUMERIC / NULLIF(COUNT(*) + 5, 0),
    4
  ) AS confidence,
  -- Total attempts (used for confidence and trend calculations)
  COUNT(*) AS total_attempts,
  COUNT(*) FILTER (WHERE fo.success = TRUE)  AS total_successes,
  COUNT(*) FILTER (WHERE fo.success = FALSE) AS total_failures,
  -- Trend delta: week-over-week success rate change
  -- Positive = improving, Negative = degrading
  ROUND(
    COALESCE(
      (
        AVG(fo.success::INT) FILTER (
          WHERE fo.timestamp > NOW() - INTERVAL '7 days'
        ) -
        AVG(fo.success::INT) FILTER (
          WHERE fo.timestamp BETWEEN NOW() - INTERVAL '14 days'
          AND NOW() - INTERVAL '7 days'
        )
      ),
      0.0
    )::NUMERIC,
    4
  ) AS trend_delta,
  -- Time-of-day split for temporal analysis (Phase 4)
  ROUND(
    AVG(fo.success::INT) FILTER (
      WHERE EXTRACT(HOUR FROM fo.timestamp AT TIME ZONE 'UTC') BETWEEN 9 AND 17
    )::NUMERIC,
    4
  ) AS business_hours_rate,
  ROUND(
    AVG(fo.success::INT) FILTER (
      WHERE EXTRACT(HOUR FROM fo.timestamp AT TIME ZONE 'UTC') NOT BETWEEN 9 AND 17
    )::NUMERIC,
    4
  ) AS after_hours_rate,
  -- Latest outcome timestamp (used for staleness detection)
  MAX(fo.timestamp) AS last_outcome_at,
  -- View refresh timestamp
  NOW() AS view_refreshed_at
FROM fact_outcomes fo
JOIN dim_actions da ON da.action_id = fo.action_id
WHERE
  fo.is_deleted   = FALSE  -- exclude soft-deleted records
  AND fo.is_synthetic = FALSE  -- CRITICAL: exclude cold-start priors from real scores
GROUP BY
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category
-- Only include actions with at least 1 real outcome
HAVING COUNT(*) >= 1;

CREATE UNIQUE INDEX mv_action_scores_unique_idx
  ON mv_action_scores (action_id, context_id, customer_id);

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
