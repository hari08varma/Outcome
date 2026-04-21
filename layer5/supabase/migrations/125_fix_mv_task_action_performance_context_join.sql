-- ============================================================================
-- Migration 125: Fix mv_task_action_performance_context dim_actions join key
--
-- Root cause fixed:
--   Migration 120 joined dim_actions using da.id, but dim_actions PK is action_id.
--   This breaks on fresh environments and can leave the MV invalid.
--
-- This migration drops and recreates the MV with the correct join key.
-- ============================================================================

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS mv_task_action_performance_context;

CREATE MATERIALIZED VIEW mv_task_action_performance_context AS
SELECT
    fo.customer_id::text                                          AS customer_id,
    fo.agent_id::text                                             AS agent_id,
    fo.task_name                                                  AS task_name,
    fo.action_id::text                                            AS action_id,
    fo.context_id::text                                           AS context_id,
    da.action_name                                                AS action_name,
    COUNT(*)                                                      AS total_count,
    SUM(CASE WHEN fo.success THEN 1 ELSE 0 END)                   AS success_count,
    AVG(CASE WHEN fo.success THEN 1.0 ELSE 0.0 END)               AS success_rate,
    AVG(COALESCE(fo.outcome_score, CASE WHEN fo.success THEN 1.0 ELSE 0.0 END))
                                                                  AS resolution_rate,
    AVG(fo.data_quality)                                          AS avg_data_quality,
    MAX(fo.timestamp)                                             AS last_seen_at,
    MIN(fo.timestamp)                                             AS first_seen_at
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_task_action_ctx_pk
    ON mv_task_action_performance_context
    (customer_id, agent_id, task_name, action_id, context_id);

CREATE INDEX IF NOT EXISTS idx_mv_task_action_ctx_lookup
    ON mv_task_action_performance_context
    (customer_id, agent_id, task_name, context_id);

CREATE INDEX IF NOT EXISTS idx_mv_task_action_ctx_customer
    ON mv_task_action_performance_context
    (customer_id, task_name, context_id);

CREATE INDEX IF NOT EXISTS idx_mv_task_action_ctx_context
    ON mv_task_action_performance_context
    (context_id, customer_id);

GRANT SELECT ON mv_task_action_performance_context TO anon, authenticated;

COMMIT;
