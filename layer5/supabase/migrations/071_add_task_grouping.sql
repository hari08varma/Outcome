-- ════════════════════════════════════════════════════════════════
-- Migration 071: Task grouping for Decision Recommendation Engine
-- Adds task_name to fact_outcomes + aggregation view
-- Safe to re-run — all operations are idempotent
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- ── Step 1: Add task_name column to fact_outcomes ──────────────
-- NULL for all existing rows — fully backward compatible
-- Developer can pass it in log_outcome; if absent, task-infer.ts
-- will auto-fill it from issue_type before insert
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS task_name VARCHAR(255) DEFAULT NULL;

-- Index for fast aggregation queries scoped by customer + task
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_task_name
  ON fact_outcomes(customer_id, task_name)
  WHERE task_name IS NOT NULL;

-- ── Step 2: Aggregation materialized view ─────────────────────
-- mv_task_action_performance: the ACTION PERFORMANCE STORE
-- Groups outcomes by (customer_id, task_name, action_id)
-- ml_score is the latest composite_score from mv_action_scores
-- This view is refreshed after every log_outcome (debounced 30s)
DROP MATERIALIZED VIEW IF EXISTS mv_task_action_performance;

CREATE MATERIALIZED VIEW mv_task_action_performance AS
SELECT
  fo.customer_id,
  fo.task_name,
  fo.action_id,
  da.action_name,
  COUNT(*)                                            AS total_count,
  COUNT(*) FILTER (WHERE fo.success = true)          AS success_count,
  ROUND(
    COUNT(*) FILTER (WHERE fo.success = true)::NUMERIC
    / NULLIF(COUNT(*), 0),
    4
  )                                                   AS success_rate,
  -- ml_score: latest composite_score from scoring engine
  -- NULL when no score exists yet (cold start for this action)
  MAX(mas.weighted_success_rate)                      AS ml_score,
  MAX(fo.timestamp)                                   AS last_seen_at
FROM fact_outcomes fo
JOIN dim_actions da
  ON da.action_id = fo.action_id
 AND da.customer_id = fo.customer_id
LEFT JOIN mv_action_scores mas
  ON mas.action_id = fo.action_id
 AND mas.customer_id = fo.customer_id
WHERE fo.task_name IS NOT NULL
GROUP BY
  fo.customer_id,
  fo.task_name,
  fo.action_id,
  da.action_name;

-- Unique index required for CONCURRENTLY refresh
CREATE UNIQUE INDEX idx_mv_task_action_perf_pk
  ON mv_task_action_performance(customer_id, task_name, action_id);

-- Index for fast lookup by customer + task
CREATE INDEX idx_mv_task_action_perf_lookup
  ON mv_task_action_performance(customer_id, task_name);

-- ── Step 3: RPC function for debounced refresh ────────────────
-- Called by log-outcome.ts after each write (debounced 30s).
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

COMMIT;

-- ── Verify ────────────────────────────────────────────────────
-- Run after migration. Expect 0 rows (no task_name data yet).
-- If mv_action_scores has data, ml_score will be non-null.
SELECT
  column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'fact_outcomes'
  AND column_name = 'task_name';
-- Expected: task_name | character varying | YES

SELECT COUNT(*) FROM mv_task_action_performance;
-- Expected: 0 (task_name not yet populated in existing rows)
