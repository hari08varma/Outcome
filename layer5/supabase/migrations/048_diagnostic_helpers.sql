-- ============================================================
-- LAYERINFINITE MIGRATION SAFETY RULES
-- 1. NEVER add NOT NULL columns to fact_outcomes without a DEFAULT or full backfill.
-- 4. ALL new FK columns on insert paths MUST be nullable (DEFAULT NULL).
-- ============================================================
--
-- Migration 048: Diagnostic Helper Functions
--
-- Adds get_customer_health() — a SECURITY DEFINER function that returns a single-row
-- health snapshot for the current customer. Dashboard Settings page calls this RPC
-- to render a health card showing outcome counts, matview status, and agent state.
--
-- SECURITY NOTE: SET search_path = public prevents search path injection attacks
-- that are possible on SECURITY DEFINER functions when search_path is not pinned.
-- ============================================================

CREATE OR REPLACE FUNCTION get_customer_health()
RETURNS TABLE(
  total_outcomes      BIGINT,
  synthetic_outcomes  BIGINT,
  real_outcomes       BIGINT,
  mv_action_scores_rows BIGINT,
  registered_actions  BIGINT,
  active_agents       BIGINT,
  last_outcome_at     TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*)                                          AS total_outcomes,
    COUNT(*) FILTER (WHERE is_synthetic = TRUE)       AS synthetic_outcomes,
    COUNT(*) FILTER (WHERE is_synthetic = FALSE)      AS real_outcomes,
    (SELECT COUNT(*) FROM mv_action_scores)           AS mv_action_scores_rows,
    (SELECT COUNT(*) FROM dim_actions WHERE is_active = TRUE) AS registered_actions,
    (SELECT COUNT(*) FROM dim_agents  WHERE is_active = TRUE) AS active_agents,
    MAX(timestamp)                                    AS last_outcome_at
  FROM fact_outcomes;
$$;

-- Grant execute to authenticated users (RLS on underlying tables is enforced separately)
GRANT EXECUTE ON FUNCTION get_customer_health() TO authenticated;
