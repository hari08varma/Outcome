-- Add 'validation_mode' column to dim_actions allowing graceful parameter omissions
ALTER TABLE dim_actions
  ADD COLUMN IF NOT EXISTS validation_mode TEXT NOT NULL DEFAULT 'advisory'
  CHECK (validation_mode IN ('strict', 'advisory', 'disabled'));

COMMENT ON COLUMN dim_actions.validation_mode IS
  'strict: missing required_params -> 400 error (safety-critical). advisory: missing params -> 200 with warnings[] in response. disabled: no param validation at all';
