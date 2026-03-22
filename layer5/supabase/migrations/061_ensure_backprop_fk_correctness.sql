-- ============================================================
-- LAYERINFINITE MIGRATION SAFETY RULES
-- 1. NEVER add NOT NULL columns to fact_outcomes without a DEFAULT or full backfill.
-- 4. ALL new FK columns on insert paths MUST be nullable (DEFAULT NULL).
-- ============================================================
--
-- Migration 061: Ensure backprop FK points to fact_episodes (CHECK-1.10-B)
--
-- Migration 035 created backprop_episode_id FK pointing to action_sequences
-- (wrong table). Migration 046 attempted to fix this with a conditional
-- IF NOT EXISTS guard — but the guard skips re-adding the constraint if ANY
-- constraint with the same name exists, regardless of which table it targets.
--
-- This migration unconditionally drops ALL FK constraints on
-- fact_outcomes.backprop_episode_id and re-adds the correct one to
-- fact_episodes. Safe to replay — uses IF EXISTS / DO $$ pattern.
-- ============================================================

-- Step 1: Drop ALL FK constraints on backprop_episode_id regardless of name
-- (catches both the standard name and any alternative name from migration 035)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'fact_outcomes'
      AND tc.table_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'backprop_episode_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE fact_outcomes DROP CONSTRAINT IF EXISTS %I',
      r.constraint_name
    );
    RAISE NOTICE 'Dropped FK constraint: %', r.constraint_name;
  END LOOP;
END $$;

-- Step 2: Re-add the correct FK to fact_episodes with ON DELETE SET NULL
ALTER TABLE fact_outcomes
  ADD CONSTRAINT fact_outcomes_backprop_episode_id_fkey
  FOREIGN KEY (backprop_episode_id)
  REFERENCES fact_episodes(episode_id)
  ON DELETE SET NULL;

-- Verification: confirm FK now references fact_episodes
SELECT
  tc.constraint_name,
  ccu.table_name AS references_table,
  ccu.column_name AS references_column
FROM information_schema.table_constraints tc
JOIN information_schema.referential_constraints rc
  ON tc.constraint_name = rc.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON rc.unique_constraint_name = ccu.constraint_name
WHERE tc.table_name = 'fact_outcomes'
  AND tc.table_schema = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
  AND tc.constraint_name = 'fact_outcomes_backprop_episode_id_fkey';
-- Expected: references_table = 'fact_episodes', references_column = 'episode_id'
