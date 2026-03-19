ALTER TABLE dim_actions 
ADD COLUMN IF NOT EXISTS customer_id UUID 
REFERENCES dim_customers(customer_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_dim_actions_customer_id 
ON dim_actions(customer_id);

ALTER TABLE dim_actions 
DROP CONSTRAINT IF EXISTS dim_actions_action_name_key;

ALTER TABLE dim_actions 
ADD CONSTRAINT dim_actions_action_name_customer_unique 
UNIQUE (action_name, customer_id);

ALTER TABLE dim_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customer_actions_isolation" ON dim_actions;
CREATE POLICY "customer_actions_isolation" ON dim_actions
  FOR ALL
  USING (
    customer_id = (
      SELECT up.customer_id 
      FROM user_profiles up 
      WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "service_role_bypass" ON dim_actions;
CREATE POLICY "service_role_bypass" ON dim_actions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);