-- ============================================================
-- LAYER5 — Migration 004: Materialized Views
-- ============================================================
-- Creates pre-computed aggregation views that power sub-5ms
-- decision queries at scale.
--
-- IMPORTANT: Views exclude is_synthetic=TRUE rows to prevent
-- cold-start priors from inflating real outcome scores.
--
-- IMPORTANT: These views use REFRESH CONCURRENTLY which
-- requires UNIQUE indexes. Those are in migration 009.
-- Apply 009 before the first Edge Function invocation.
-- ============================================================

-- ────────────────────────────────────────────
-- VIEW 1: mv_action_scores
-- Pre-computed per-action scoring metrics.
-- The GET /v1/get-scores API reads EXCLUSIVELY
-- from this view — never from fact_outcomes directly.
-- Refreshed every 5 minutes by the scoring-engine
-- Edge Function.
-- ────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_action_scores AS
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
      AVG(fo.success::INT) FILTER (
        WHERE fo.timestamp > NOW() - INTERVAL '7 days'
      ) -
      AVG(fo.success::INT) FILTER (
        WHERE fo.timestamp BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      )
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


-- ────────────────────────────────────────────
-- VIEW 2: mv_episode_patterns
-- Pre-computed successful action sequences.
-- Powers GET /v1/get-patterns.
-- Refreshed nightly by the scoring-engine function.
-- ────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_episode_patterns AS
SELECT
  fe.context_id,
  fe.customer_id,
  fe.action_sequence,
  -- Hash of the action_sequence JSONB for UNIQUE index on CONCURRENTLY refresh
  MD5(fe.action_sequence::TEXT) AS action_sequence_hash,
  ROUND(
    AVG(
      CASE WHEN fe.episode_success THEN 1.0 ELSE 0.0 END
    )::NUMERIC,
    4
  ) AS episode_success_rate,
  ROUND(AVG(fe.duration_ms)::NUMERIC, 0)     AS avg_duration_ms,
  COUNT(*)                                     AS sample_count,
  MAX(fe.ended_at)                             AS last_seen_at,
  NOW()                                        AS view_refreshed_at
FROM fact_episodes fe
WHERE
  fe.action_sequence IS NOT NULL
  AND fe.action_sequence != '[]'::JSONB
  AND fe.ended_at IS NOT NULL
GROUP BY
  fe.context_id,
  fe.customer_id,
  fe.action_sequence
-- Require at least 2 completed episodes to form a pattern
HAVING COUNT(*) >= 2;
