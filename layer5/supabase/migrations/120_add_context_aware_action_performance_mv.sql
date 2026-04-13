-- ============================================================================
-- Migration 120: Context-aware action performance materialized view
--
-- Creates mv_task_action_performance_context to pre-aggregate success/score
-- metrics broken down by (customer_id, agent_id, task_name, action_id, context_id).
--
-- This is the context-aware companion to mv_task_action_performance_180d which
-- only groups by (customer_id, agent_id, task_name, action_id) and has no
-- context dimension.
--
-- Use case: When a recommendation request includes issue_type/environment params,
-- the engine can query this MV for context-specific signal then blend with the
-- global MV using alpha = min(1, context_samples / 30).
--
-- Window: rolling 180 days (matches the global MV window).
-- Refresh: on same schedule as mv_task_action_performance_180d.
-- ============================================================================

BEGIN;

-- ── Step 1: Context-aware performance MV ─────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_task_action_performance_context AS
SELECT
    fo.customer_id::text                                          AS customer_id,
    fo.agent_id::text                                            AS agent_id,
    fo.task_name                                                 AS task_name,
    fo.action_id::text                                           AS action_id,
    fo.context_id::text                                          AS context_id,
    da.action_name                                               AS action_name,
    COUNT(*)                                                     AS total_count,
    SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)                  AS success_count,
    AVG(CASE WHEN fo.success THEN 1.0 ELSE 0.0 END)              AS success_rate,
    AVG(COALESCE(fo.outcome_score, CASE WHEN fo.success THEN 1.0 ELSE 0.0 END))
                                                                 AS resolution_rate,
    AVG(fo.data_quality)                                         AS avg_data_quality,
    MAX(fo.timestamp)                                            AS last_seen_at,
    MIN(fo.timestamp)                                            AS first_seen_at
FROM fact_outcomes fo
JOIN dim_actions da ON da.action_id = fo.action_id
WHERE fo.is_deleted   = false
  AND fo.is_synthetic = false
  AND fo.context_id   IS NOT NULL
  AND fo.timestamp    >= NOW() - INTERVAL '180 days'
GROUP BY
    fo.customer_id,
    fo.agent_id,
    fo.task_name,
    fo.action_id,
    fo.context_id,
    da.action_name;

-- ── Step 2: Unique index for CONCURRENTLY refresh ────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_task_action_ctx_pk
    ON mv_task_action_performance_context
    (customer_id, agent_id, task_name, action_id, context_id);

-- ── Step 3: Lookup indexes ────────────────────────────────────
-- Scoped lookup: customer + agent + task + context (main query path)
CREATE INDEX IF NOT EXISTS idx_mv_task_action_ctx_lookup
    ON mv_task_action_performance_context
    (customer_id, agent_id, task_name, context_id);

-- Customer-wide lookup (blended across agents, scoped to context)
CREATE INDEX IF NOT EXISTS idx_mv_task_action_ctx_customer
    ON mv_task_action_performance_context
    (customer_id, task_name, context_id);

-- Context-only lookup (for context cold-start detection)
CREATE INDEX IF NOT EXISTS idx_mv_task_action_ctx_context
    ON mv_task_action_performance_context
    (context_id, customer_id);

-- ── Step 4: Grant read access ─────────────────────────────────
GRANT SELECT ON mv_task_action_performance_context TO anon, authenticated;

COMMIT;

-- ── Step 5: Initial population ────────────────────────────────
-- Run outside transaction so CONCURRENTLY works if MV already has rows.
-- On first run this is equivalent to a regular REFRESH.
REFRESH MATERIALIZED VIEW mv_task_action_performance_context;
