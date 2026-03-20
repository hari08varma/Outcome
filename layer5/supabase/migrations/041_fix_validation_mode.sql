-- Fix any dim_actions rows with invalid validation_mode 
-- caused by the 'none' bug in validate-action.ts prior to this fix.
-- Idempotent: safe to run multiple times.
UPDATE dim_actions
SET validation_mode = 'advisory'
WHERE validation_mode NOT IN ('strict', 'advisory', 'disabled');

-- Ensure required_params defaults to empty array not NULL
ALTER TABLE dim_actions
  ALTER COLUMN required_params SET DEFAULT '[]'::jsonb;

UPDATE dim_actions
SET required_params = '[]'::jsonb
WHERE required_params IS NULL;
