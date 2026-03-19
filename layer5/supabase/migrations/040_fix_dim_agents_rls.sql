-- Allow authenticated users to SELECT their own agents
-- (INSERT/UPDATE/DELETE remain service_role only)

ALTER TABLE dim_agents ENABLE ROW LEVEL SECURITY;

-- Drop any broken existing policies
DROP POLICY IF EXISTS "agents_select_own" ON dim_agents;
DROP POLICY IF EXISTS "agents_customer_isolation" ON dim_agents;

-- SELECT: users can read their own customer's agents
CREATE POLICY "agents_select_own" ON dim_agents
  FOR SELECT
  USING (
    customer_id = (
      SELECT up.customer_id 
      FROM user_profiles up 
      WHERE up.id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: service role only (backend API)
-- No policy needed — without a policy, anon/auth roles 
-- cannot INSERT/UPDATE/DELETE (RLS blocks by default)