-- ============================================================
-- LAYERINFINITE — Migration 106: Add avg_response_ms to mv_action_scores
-- ============================================================
-- Why:
--   Composite recommendation scoring now includes a latency factor.
--   The latest mv_action_scores definition must expose avg_response_ms
--   so scoring.ts can compute context-relative latency penalties/bonuses.
--
-- Safety:
--   - Preserves canonical confidence denominator n/(n+10).
--   - Preserves existing output columns used by API consumers.
--   - Adds one nullable latency column: avg_response_ms.
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
  -- Confidence (canonical): n / (n + 10)
  ROUND(
    COUNT(*)::NUMERIC / NULLIF(COUNT(*) + 10, 0),
    4
  ) AS confidence,
  COUNT(*) AS total_attempts,
  COUNT(*) FILTER (WHERE fo.success = TRUE)  AS total_successes,
  COUNT(*) FILTER (WHERE fo.success = FALSE) AS total_failures,
  -- Trend delta: week-over-week success change
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
  -- New latency signal for composite scoring factor.
  ROUND(
    (AVG(fo.response_time_ms) FILTER (WHERE fo.response_time_ms IS NOT NULL))::NUMERIC,
    2
  ) AS avg_response_ms,
  MAX(fo.timestamp) AS last_outcome_at,
  NOW() AS view_refreshed_at
FROM fact_outcomes fo
JOIN dim_actions da ON da.action_id = fo.action_id
WHERE
  fo.is_deleted = FALSE
  AND fo.is_synthetic = FALSE
GROUP BY
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category
HAVING COUNT(*) >= 1;

CREATE UNIQUE INDEX mv_action_scores_unique_idx
  ON mv_action_scores (action_id, context_id, customer_id);

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;