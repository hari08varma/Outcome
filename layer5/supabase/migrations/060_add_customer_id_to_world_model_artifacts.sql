-- ============================================================
-- LAYERINFINITE MIGRATION SAFETY RULES
-- 1. NEVER add NOT NULL columns to fact_outcomes without a DEFAULT or full backfill.
-- 4. ALL new FK columns on insert paths MUST be nullable (DEFAULT NULL).
-- ============================================================
--
-- Migration 060: Add customer_id to world_model_artifacts
--
-- Fixes ML-CHECK-2.10 (P0): the training script previously stored one
-- global model for all tenants. Adding customer_id enables per-customer
-- model isolation so each tenant's recommendations are trained only on
-- their own outcome data.
--
-- Column is nullable to preserve backward compatibility with existing
-- rows (which represent the legacy global model).
-- ============================================================

ALTER TABLE world_model_artifacts
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES dim_customers(customer_id) ON DELETE CASCADE;

-- Index for efficient per-customer active model lookups
CREATE INDEX IF NOT EXISTS idx_world_model_artifacts_customer_active
  ON world_model_artifacts(customer_id, tier, is_active)
  WHERE is_active = TRUE;

-- Verification
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'world_model_artifacts' AND column_name = 'customer_id';
-- Expected: one row | column_name=customer_id | data_type=uuid | is_nullable=YES
