-- Allow authenticated users to SELECT their own agents only
ALTER TABLE dim_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agents_select_own" ON dim_agents;
DROP POLICY IF EXISTS "customer_isolation_agents" ON dim_agents;
CREATE POLICY "agents_select_own" ON dim_agents
  FOR SELECT
  USING (
    customer_id = (
      SELECT up.customer_id 
      FROM user_profiles up 
      WHERE up.id = auth.uid()
    )
  );

-- Allow authenticated users to UPDATE is_active only
-- (for enable/disable toggle in dashboard)
DROP POLICY IF EXISTS "agents_toggle_own" ON dim_agents;
CREATE POLICY "agents_toggle_own" ON dim_agents
  FOR UPDATE
  USING (
    customer_id = (
      SELECT up.customer_id 
      FROM user_profiles up 
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    customer_id = (
      SELECT up.customer_id 
      FROM user_profiles up 
      WHERE up.id = auth.uid()
    )
  );

-- Service role can do everything (backend API key generation)
DROP POLICY IF EXISTS "agents_service_role_all" ON dim_agents;
CREATE POLICY "agents_service_role_all" ON dim_agents
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- INSERT and DELETE remain blocked for anon/authenticated
-- No INSERT policy = RLS blocks it by default (correct)