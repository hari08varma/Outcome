-- ============================================================
-- LAYER5 — Migration 015: Update mv_action_scores for Outcome Scoring
-- ============================================================
-- Replaces success::INT with COALESCE(outcome_score, success::FLOAT)
-- throughout the materialized view. This makes the scoring system
-- use nuanced 0.0–1.0 scores when available, falling back to
-- binary success (1.0/0.0) for old records where outcome_score=NULL.
--
-- BACKWARD COMPATIBLE: existing rows have outcome_score=NULL,
-- so COALESCE falls through to success::FLOAT — identical behavior.
-- ============================================================

-- Drop existing view (and its indexes)
DROP MATERIALIZED VIEW IF EXISTS mv_action_scores;

-- Recreate with COALESCE(outcome_score, success::FLOAT)
CREATE MATERIALIZED VIEW mv_action_scores AS
SELECT
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category,
  -- Raw success rate: uses outcome_score if available, else binary
  ROUND(
    AVG(COALESCE(fo.outcome_score, fo.success::FLOAT))::NUMERIC,
    4
  ) AS raw_success_rate,
  -- Recency-weighted success rate
  -- More recent outcomes get exponentially higher weight
  -- weight = exp(-0.01 * hours_ago) where hours_ago = age in hours
  ROUND(
    SUM(
      COALESCE(fo.outcome_score, fo.success::FLOAT) *
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
  -- confidence = n / (n + 10) — ranges from ~0 (n=0) to 1.0 (n=∞)
  ROUND(
    COUNT(*)::NUMERIC / NULLIF(COUNT(*) + 10, 0),
    4
  ) AS confidence,
  -- Total attempts (used for confidence and trend calculations)
  COUNT(*) AS total_attempts,
  COUNT(*) FILTER (WHERE fo.success = TRUE)  AS total_successes,
  COUNT(*) FILTER (WHERE fo.success = FALSE) AS total_failures,
  -- Trend delta: week-over-week success rate change
  -- Positive = improving, Negative = degrading
  ROUND(
    (
      AVG(COALESCE(fo.outcome_score, fo.success::FLOAT)) FILTER (
        WHERE fo.timestamp > NOW() - INTERVAL '7 days'
      ) -
      AVG(COALESCE(fo.outcome_score, fo.success::FLOAT)) FILTER (
        WHERE fo.timestamp BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      )
    )::NUMERIC,
    4
  ) AS trend_delta,
  -- Time-of-day split for temporal analysis
  ROUND(
    AVG(COALESCE(fo.outcome_score, fo.success::FLOAT)) FILTER (
      WHERE EXTRACT(HOUR FROM fo.timestamp AT TIME ZONE 'UTC') BETWEEN 9 AND 17
    )::NUMERIC,
    4
  ) AS business_hours_rate,
  ROUND(
    AVG(COALESCE(fo.outcome_score, fo.success::FLOAT)) FILTER (
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
  fo.is_deleted   = FALSE
  AND fo.is_synthetic = FALSE
GROUP BY
  fo.action_id,
  fo.context_id,
  fo.customer_id,
  da.action_name,
  da.action_category
HAVING COUNT(*) >= 1;

-- Recreate the UNIQUE index required for REFRESH CONCURRENTLY
CREATE UNIQUE INDEX ux_action_scores_composite
  ON mv_action_scores(action_id, context_id, customer_id);
