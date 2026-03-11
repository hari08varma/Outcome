-- ============================================================
-- LAYER5 — Migration 006: Row Level Security Policies
-- ============================================================
-- Every customer-scoped table gets RLS enforced.
-- The API uses the service role key server-side and enforces
-- customer_id in query logic. RLS is defense-in-depth for
-- direct DB access (e.g., dashboard, Supabase Studio).
-- ============================================================

-- ────────────────────────────────────────────
-- Enable RLS on all customer-scoped tables
-- ────────────────────────────────────────────
ALTER TABLE fact_outcomes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_episodes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_outcomes_archive  ENABLE ROW LEVEL SECURITY;
ALTER TABLE dim_agents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE dim_contexts           ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────
-- Policies: customer isolation
-- Pattern: customer_id must match the authenticated
-- user's ID (auth.uid()). Each policy is named
-- per table for clear audit trail.
-- ────────────────────────────────────────────

-- fact_outcomes: core outcome data
CREATE POLICY "customer_isolation_outcomes" ON fact_outcomes
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);

-- fact_episodes: episode data
CREATE POLICY "customer_isolation_episodes" ON fact_episodes
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);

-- fact_outcomes_archive: archived outcome data
CREATE POLICY "customer_isolation_archive" ON fact_outcomes_archive
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);

-- dim_agents: agent registry — customers see only their agents
CREATE POLICY "customer_isolation_agents" ON dim_agents
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);

-- dim_contexts: contexts are not customer-scoped in schema
-- but we add a SELECT policy for safety
-- (contexts may be shared across customers in future)
-- For now: allow all authenticated users to read contexts
CREATE POLICY "read_all_contexts" ON dim_contexts
  FOR SELECT TO authenticated
  USING (TRUE);

-- ────────────────────────────────────────────
-- dim_actions and dim_customers: global tables
-- dim_actions is shared (action registry is global)
-- dim_customers uses its own PK for auth lookup
-- ────────────────────────────────────────────

-- dim_actions: all authenticated users can read
-- (needed for hallucination prevention validation)
ALTER TABLE dim_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_all_actions" ON dim_actions
  FOR SELECT TO authenticated
  USING (TRUE);

-- dim_customers: customers can only see their own record
ALTER TABLE dim_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_isolation_self" ON dim_customers
  FOR ALL TO authenticated
  USING (customer_id = auth.uid()::uuid);

-- dim_institutional_knowledge: read-only for all authenticated
ALTER TABLE dim_institutional_knowledge ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_all_institutional" ON dim_institutional_knowledge
  FOR SELECT TO authenticated
  USING (TRUE);

-- ────────────────────────────────────────────
-- Service role bypass
-- The service role key bypasses RLS by default
-- in Supabase. No additional policy needed for
-- the API server (which uses service role key).
-- ────────────────────────────────────────────
