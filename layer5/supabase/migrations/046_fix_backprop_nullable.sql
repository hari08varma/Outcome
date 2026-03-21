-- ============================================================
-- LAYERINFINITE MIGRATION SAFETY RULES
-- 1. NEVER add NOT NULL columns to fact_outcomes without a DEFAULT or full backfill.
-- 2. NEVER rename or drop columns referenced by materialized views without dropping
--    and recreating the view in the same migration.
-- 3. ALWAYS test: INSERT INTO fact_outcomes (...minimal SDK payload...) after any
--    schema change. If it fails, the migration is broken.
-- 4. ALL new FK columns on insert paths MUST be nullable (DEFAULT NULL).
-- 5. After any migration touching mv_action_scores definition, run:
--    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores; at end of migration.
-- ============================================================
--
-- RULE: backprop_episode_id is an INTERNAL backprop field.
-- NEVER map the SDK's episode_id field to this column — they reference different tables.
-- The SDK's episode_id is for sequence tracking; backprop_episode_id is set by the
-- backprop engine only, after fact_episodes rows have been created.
--
-- Root cause of Bug 1:
--   Migration 034 added backprop_episode_id with FK → fact_episodes.
--   log-outcome.ts was mapping body.episode_id → backprop_episode_id.
--   body.episode_id is a client-generated UUID that doesn't exist in fact_episodes.
--   → FK violation 23503 on every request that sends episode_id.
--
-- Fix:
--   1. Drop old FK constraint (may have been created with a different name on some DBs).
--   2. Ensure column is nullable.
--   3. Re-add FK with ON DELETE SET NULL — now safe because code no longer
--      passes SDK episode_id values to this column.
-- ============================================================

-- Step 1: Drop the FK constraint (idempotent via IF EXISTS)
ALTER TABLE fact_outcomes
  DROP CONSTRAINT IF EXISTS fact_outcomes_backprop_episode_id_fkey;

-- Step 2: Ensure column is nullable (idempotent no-op if already nullable)
ALTER TABLE fact_outcomes
  ALTER COLUMN backprop_episode_id DROP NOT NULL;

-- Step 3: Re-add FK with ON DELETE SET NULL, guarded for idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fact_outcomes_backprop_episode_id_fkey'
      AND table_name = 'fact_outcomes'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT fact_outcomes_backprop_episode_id_fkey
      FOREIGN KEY (backprop_episode_id)
      REFERENCES fact_episodes(episode_id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL; -- Already exists, skip silently
END $$;
