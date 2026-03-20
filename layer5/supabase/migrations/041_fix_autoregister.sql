UPDATE dim_actions
SET validation_mode = 'advisory'
WHERE validation_mode IS NULL
   OR validation_mode NOT IN ('strict', 'advisory', 'disabled');

ALTER TABLE dim_actions
ALTER COLUMN required_params SET DEFAULT '[]'::jsonb;

UPDATE dim_actions
SET required_params = '[]'::jsonb
WHERE required_params IS NULL;
