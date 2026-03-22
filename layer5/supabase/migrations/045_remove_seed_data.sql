-- Remove cold-start seed actions (the 8 fake actions)
-- Target seed UUIDs by known prefix (b0000000-...) to avoid deleting real production records.
DELETE FROM dim_actions
WHERE action_id::text LIKE 'b0000000-0000-0000-0000-%';

-- Remove seed institutional knowledge rows
-- dim_institutional_knowledge has no is_synthetic column.
-- All seed action UUIDs follow the pattern b0000000-0000-0000-0000-* (cold_start_priors.sql).
-- Pattern match handles any future seed action additions without needing to update this list.
DELETE FROM dim_institutional_knowledge
WHERE action_id::text LIKE 'b0000000-0000-0000-0000-%';

-- Remove seed cold-start prior outcomes (synthetic rows)
-- Guard: check column exists to prevent failure if migrations run out of order.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fact_outcomes' AND column_name = 'is_synthetic'
  ) THEN
    DELETE FROM fact_outcomes WHERE is_synthetic = true;
  ELSE
    RAISE NOTICE '045: is_synthetic column not found on fact_outcomes, skipping synthetic row cleanup';
  END IF;
END $$;

-- Remove the seed agent (d0000000-... prefix matches cold_start_priors.sql seed UUID)
DELETE FROM dim_agents
WHERE agent_id::text LIKE 'd0000000-0000-0000-0000-%';

-- Verify: after this migration, dim_actions should be empty
-- for any customer who has not yet used the SDK.
