-- ============================================================
-- LAYERINFINITE MIGRATION SAFETY RULES
-- 1. NEVER add NOT NULL columns to fact_outcomes without a DEFAULT or full backfill.
-- 4. ALL new FK columns on insert paths MUST be nullable (DEFAULT NULL).
-- ============================================================
--
-- Migration 062: Atomic trust score update + audit INSERT RPC
--
-- Fixes ML-CHECK-2.1-B (P1): outcome-orchestrator.ts previously executed
-- UPDATE agent_trust_scores and INSERT agent_trust_audit as two separate
-- DB operations. A network error or constraint violation between the two
-- left trust score updated but no audit row — violating INVARIANT 7.
--
-- This RPC wraps both operations in one PL/pgSQL function, executed as a
-- single atomic transaction. The TypeScript caller is updated to use
-- supabase.rpc('update_trust_and_audit', {...}).
-- ============================================================

CREATE OR REPLACE FUNCTION update_trust_and_audit(
  p_agent_id              UUID,
  p_customer_id           UUID,
  p_trust_score           NUMERIC,
  p_total_decisions       BIGINT,
  p_correct_decisions     BIGINT,
  p_consecutive_failures  INT,
  p_trust_status          TEXT,
  p_suspension_reason     TEXT,
  p_updated_at            TIMESTAMPTZ,
  p_event_type            TEXT,
  p_old_score             NUMERIC,
  p_old_status            TEXT,
  p_new_status            TEXT,
  p_performed_by          TEXT,
  p_reason                TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Atomically update trust score and write audit row in one transaction.
  -- If either operation fails, both are rolled back.

  UPDATE agent_trust_scores
  SET
    trust_score           = p_trust_score,
    total_decisions       = p_total_decisions,
    correct_decisions     = p_correct_decisions,
    consecutive_failures  = p_consecutive_failures,
    trust_status          = p_trust_status,
    suspension_reason     = p_suspension_reason,
    updated_at            = p_updated_at
  WHERE agent_id = p_agent_id;

  INSERT INTO agent_trust_audit (
    agent_id,
    customer_id,
    event_type,
    old_score,
    new_score,
    old_status,
    new_status,
    performed_by,
    reason
  ) VALUES (
    p_agent_id,
    p_customer_id,
    p_event_type,
    p_old_score,
    p_trust_score,
    p_old_status,
    p_new_status,
    p_performed_by,
    p_reason
  );
END;
$$;

-- Grant execute to authenticated and service_role
GRANT EXECUTE ON FUNCTION update_trust_and_audit TO service_role;

-- Verification
SELECT routine_name, routine_type, security_type
FROM information_schema.routines
WHERE routine_name = 'update_trust_and_audit'
  AND routine_schema = 'public';
-- Expected: one row | routine_type = FUNCTION | security_type = DEFINER
