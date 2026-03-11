-- ============================================================
-- LAYER5 — Migration 025: Foundation RLS Policies
-- ============================================================
-- Enables Row Level Security on all new foundation tables
-- and creates customer isolation policies following the
-- exact pattern established in 006_create_rls_policies.sql.
--
-- New tables that are agent-scoped (no direct customer_id):
--   fact_decisions, action_sequences — use subquery on dim_agents
--
-- fact_outcome_counterfactuals — uses subquery through
--   fact_decisions → dim_agents chain
--
-- world_model_artifacts — read-only for authenticated users,
--   write access via service_role only (training service)
-- ============================================================

-- ────────────────────────────────────────────
-- Enable RLS on all new tables
-- ────────────────────────────────────────────
ALTER TABLE fact_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_outcome_counterfactuals ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_model_artifacts ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────
-- fact_decisions: customers see only their own agent decisions
-- ────────────────────────────────────────────
CREATE POLICY fact_decisions_select ON fact_decisions
  FOR SELECT
  USING (
    agent_id IN (
      SELECT agent_id FROM dim_agents
      WHERE customer_id = auth.uid()::uuid
    )
  );

CREATE POLICY fact_decisions_insert ON fact_decisions
  FOR INSERT
  WITH CHECK (
    agent_id IN (
      SELECT agent_id FROM dim_agents
      WHERE customer_id = auth.uid()::uuid
    )
  );

-- ────────────────────────────────────────────
-- action_sequences: same agent-scoped pattern
-- ────────────────────────────────────────────
CREATE POLICY action_sequences_select ON action_sequences
  FOR SELECT
  USING (
    agent_id IN (
      SELECT agent_id FROM dim_agents
      WHERE customer_id = auth.uid()::uuid
    )
  );

CREATE POLICY action_sequences_insert ON action_sequences
  FOR INSERT
  WITH CHECK (
    agent_id IN (
      SELECT agent_id FROM dim_agents
      WHERE customer_id = auth.uid()::uuid
    )
  );

CREATE POLICY action_sequences_update ON action_sequences
  FOR UPDATE
  USING (
    agent_id IN (
      SELECT agent_id FROM dim_agents
      WHERE customer_id = auth.uid()::uuid
    )
  );

-- ────────────────────────────────────────────
-- fact_outcome_counterfactuals: customers see their own
-- (through fact_decisions → dim_agents chain)
-- ────────────────────────────────────────────
CREATE POLICY counterfactuals_select ON fact_outcome_counterfactuals
  FOR SELECT
  USING (
    decision_id IN (
      SELECT fd.id FROM fact_decisions fd
      JOIN dim_agents da ON da.agent_id = fd.agent_id
      WHERE da.customer_id = auth.uid()::uuid
    )
  );

-- ────────────────────────────────────────────
-- world_model_artifacts: read-only for all authenticated users
-- Write access only via service_role (training service)
-- ────────────────────────────────────────────
CREATE POLICY world_model_select ON world_model_artifacts
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Edge functions use service_role → bypass RLS automatically.
-- No insert/update policy needed here for authenticated users.
