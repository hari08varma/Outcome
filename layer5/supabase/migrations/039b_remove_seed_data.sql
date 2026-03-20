-- Remove cold-start seed actions (the 8 fake actions)
-- These were inserted by coldstartpriors.sql for dev testing
DELETE FROM dim_actions 
WHERE created_at < '2026-03-10'  
AND customer_id IN (
  SELECT customer_id FROM dim_customers 
  WHERE created_at < '2026-03-10'
);

-- Remove seed institutional knowledge rows (12 rows)
DELETE FROM dim_institutional_knowledge
WHERE is_synthetic = true;

-- Remove seed cold-start prior outcomes (synthetic rows)
DELETE FROM fact_outcomes
WHERE is_synthetic = true;

-- Remove the seed customer and their default agent
-- (the one created by coldstartpriors.sql, not by real signup)
DELETE FROM dim_agents
WHERE created_at < '2026-03-10'
AND agent_name = 'default-agent'
AND customer_id IN (
  SELECT customer_id FROM dim_customers
  WHERE created_at < '2026-03-10'
);

-- Verify: after this migration, dim_actions should be empty
-- for any customer who has not yet used the SDK.
