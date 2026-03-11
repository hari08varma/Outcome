-- ============================================================
-- LAYER5 — Migration 023: Materialized View — mv_sequence_scores
-- ============================================================
-- Computes statistical performance of every observed action
-- sequence per context type. Used by Tier 1 simulation
-- (Wilson CI and t-CI).
--
-- Includes:
--   - Wilson CI for resolution_rate (binary proportion)
--   - t-CI for mean_outcome (continuous)
--   - Interval width for prediction confidence
--
-- Requires action_sequences table from migration 020.
-- Refreshed concurrently on the same schedule as other MVs.
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS mv_sequence_scores;

CREATE MATERIALIZED VIEW mv_sequence_scores AS
WITH sequence_stats AS (
  SELECT
    action_sequence,
    context_hash,
    COUNT(*)                              AS n,
    AVG(final_outcome)                    AS mean_outcome,
    STDDEV(final_outcome)                 AS std_outcome,
    SUM(resolved::INT)::FLOAT             AS resolved_count,
    AVG(total_response_ms)                AS avg_response_ms,
    AVG(sequence_length)                  AS avg_steps,
    MIN(sequence_length)                  AS min_steps,
    MAX(sequence_length)                  AS max_steps
  FROM action_sequences
  WHERE
    final_outcome IS NOT NULL
    AND closed_at IS NOT NULL
  GROUP BY action_sequence, context_hash
  HAVING COUNT(*) >= 3  -- minimum 3 observations
),
wilson_ci AS (
  SELECT
    *,
    -- Wilson CI for resolution_rate (binary proportion)
    -- z = 1.96 for 95% confidence
    resolved_count / n AS resolution_rate,

    -- Wilson lower bound
    (
      (resolved_count / n) + (3.8416 / (2 * n)) -
      1.96 * SQRT(
        (resolved_count / n) * (1.0 - (resolved_count / n)) / n +
        3.8416 / (4.0 * n * n)
      )
    ) / (1.0 + 3.8416 / n) AS wilson_lower,

    -- Wilson upper bound
    (
      (resolved_count / n) + (3.8416 / (2 * n)) +
      1.96 * SQRT(
        (resolved_count / n) * (1.0 - (resolved_count / n)) / n +
        3.8416 / (4.0 * n * n)
      )
    ) / (1.0 + 3.8416 / n) AS wilson_upper,

    -- t-CI for mean_outcome (continuous)
    -- Using normal approximation (valid for n >= 3)
    CASE WHEN n > 1 AND std_outcome IS NOT NULL
      THEN mean_outcome - 1.96 * std_outcome / SQRT(n)
      ELSE mean_outcome
    END AS outcome_lower_ci,

    CASE WHEN n > 1 AND std_outcome IS NOT NULL
      THEN mean_outcome + 1.96 * std_outcome / SQRT(n)
      ELSE mean_outcome
    END AS outcome_upper_ci,

    -- Interval width — used to determine prediction confidence
    CASE WHEN n > 1 AND std_outcome IS NOT NULL
      THEN (1.96 * std_outcome / SQRT(n)) * 2
      ELSE 1.0  -- maximum uncertainty when std unknown
    END AS outcome_interval_width

  FROM sequence_stats
)
SELECT
  action_sequence,
  context_hash,
  n                     AS observations,
  mean_outcome,
  std_outcome,
  outcome_lower_ci,
  outcome_upper_ci,
  outcome_interval_width,
  resolution_rate,
  wilson_lower          AS resolution_rate_lower,
  wilson_upper          AS resolution_rate_upper,
  avg_response_ms,
  avg_steps,
  min_steps,
  max_steps,
  NOW()                 AS refreshed_at
FROM wilson_ci;

-- ────────────────────────────────────────────
-- Unique index required for REFRESH CONCURRENTLY
-- ────────────────────────────────────────────
CREATE UNIQUE INDEX idx_mv_sequence_scores_pk
  ON mv_sequence_scores (action_sequence, context_hash);

-- Performance index
CREATE INDEX idx_mv_sequence_scores_context
  ON mv_sequence_scores (context_hash);

COMMENT ON MATERIALIZED VIEW mv_sequence_scores IS
  'Statistical performance of every observed sequence '
  'per context type. Includes Wilson CI for resolution_rate '
  'and t-CI for mean_outcome. Used by Tier 1 simulation. '
  'Refreshed concurrently on the same schedule as other MVs.';
