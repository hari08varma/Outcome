-- ============================================================
-- LAYERINFINITE — Migration 016: Add Latency Stats to mv_action_scores
-- ============================================================
-- Adds p50, p95 latency, baseline p95 (14-30 days ago),
-- and spike ratio (current p95 / baseline p95).
-- All existing columns preserved identically from migration 015.
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS mv_action_scores;

CREATE MATERIALIZED VIEW mv_action_scores AS
SELECT
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category,
  -- Raw success rate
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
  -- Confidence: n / (n + 10)
  ROUND(
    COUNT(*)::NUMERIC / NULLIF(COUNT(*) + 10, 0),
    4
  ) AS confidence,
  -- Counts
  COUNT(*) AS total_attempts,
  COUNT(*) FILTER (WHERE fo.success = TRUE)  AS total_successes,
  COUNT(*) FILTER (WHERE fo.success = FALSE) AS total_failures,
  -- Trend delta: week-over-week
  ROUND(
    (
      AVG(fo.success::INT) FILTER (
        WHERE fo.timestamp > NOW() - INTERVAL '7 days'
      ) -
      AVG(fo.success::INT) FILTER (
        WHERE fo.timestamp BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      )
    )::NUMERIC,
    4
  ) AS trend_delta,
  -- Time-of-day split
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
  -- Latest outcome timestamp
  MAX(fo.timestamp) AS last_outcome_at,
  -- View refresh timestamp
  NOW() AS view_refreshed_at,

  -- ════════════════════════════════════════════
  -- NEW: Latency statistics (Gap 1)
  -- ════════════════════════════════════════════

  -- Median latency (p50)
  PERCENTILE_CONT(0.50) WITHIN GROUP
    (ORDER BY fo.response_time_ms)
    FILTER (WHERE fo.response_time_ms IS NOT NULL)
    AS latency_p50_ms,

  -- 95th percentile latency (current — all time)
  PERCENTILE_CONT(0.95) WITHIN GROUP
    (ORDER BY fo.response_time_ms)
    FILTER (WHERE fo.response_time_ms IS NOT NULL)
    AS latency_p95_ms,

  -- Baseline p95: from 14-30 days ago (stable historical window)
  PERCENTILE_CONT(0.95) WITHIN GROUP
    (ORDER BY fo.response_time_ms)
    FILTER (
      WHERE fo.response_time_ms IS NOT NULL
      AND fo.timestamp < NOW() - INTERVAL '14 days'
      AND fo.timestamp >= NOW() - INTERVAL '30 days'
    ) AS latency_p95_baseline_ms,

  -- Spike ratio: recent p95 / baseline p95
  -- NULL if no baseline data yet (prevents division by zero)
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
WHERE
  fo.is_deleted   = FALSE
  AND fo.is_synthetic = FALSE
GROUP BY
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category
HAVING COUNT(*) >= 1;

-- Recreate UNIQUE index (required for REFRESH CONCURRENTLY)
CREATE UNIQUE INDEX ux_action_scores_composite
  ON mv_action_scores(action_id, context_id, customer_id);
