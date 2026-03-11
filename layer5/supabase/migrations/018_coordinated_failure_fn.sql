-- ============================================================
-- LAYER5 — Migration 018: Coordinated Failure Detection Function
-- ============================================================
-- SQL function called by trend-detector Edge Function.
-- Detects 3+ agents failing the SAME action within a time window.
-- Indicates shared infrastructure failure, not individual agent issues.
-- ============================================================

CREATE OR REPLACE FUNCTION detect_coordinated_failures(
  window_minutes INT DEFAULT 15,
  min_agent_count INT DEFAULT 3
)
RETURNS TABLE (
  customer_id   UUID,
  action_id     UUID,
  action_name   VARCHAR,
  agent_count   BIGINT,
  failure_count BIGINT,
  window_start  TIMESTAMPTZ,
  window_end    TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    fo.customer_id,
    fo.action_id,
    da.action_name,
    COUNT(DISTINCT fo.agent_id)    AS agent_count,
    COUNT(*)                       AS failure_count,
    MIN(fo.timestamp)              AS window_start,
    MAX(fo.timestamp)              AS window_end
  FROM fact_outcomes fo
  JOIN dim_actions da
    ON da.action_id = fo.action_id
  WHERE
    fo.success = FALSE
    AND fo.timestamp >= NOW() -
        (window_minutes || ' minutes')::INTERVAL
    AND fo.is_deleted = FALSE
  GROUP BY
    fo.customer_id,
    fo.action_id,
    da.action_name
  HAVING
    COUNT(DISTINCT fo.agent_id) >= min_agent_count
  ORDER BY
    agent_count DESC,
    failure_count DESC;
$$;
