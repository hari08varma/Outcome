-- ============================================================================
-- Migration 100: Reconcile fact_decisions.episode_id semantics
--
-- Why:
--   Some live databases can reject get-scores decision inserts when episode_id
--   is omitted, which causes decision_id to come back null for standard calls.
--
-- What this migration enforces:
--   1) fact_decisions.episode_id exists and is nullable
--   2) episode_id has no forced default
--   3) any stale FK on episode_id is removed
--
-- Notes:
--   episode_id in get-scores is an SDK correlation/grouping value and must be
--   optional. It should not block decision persistence for non-episode calls.
--
-- Safe to rerun:
--   - all operations are guarded with existence checks
-- ============================================================================

BEGIN;

-- Ensure episode_id exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fact_decisions'
      AND column_name = 'episode_id'
  ) THEN
    ALTER TABLE fact_decisions
      ADD COLUMN episode_id UUID;
  END IF;
END $$;

-- Ensure episode_id is nullable and has no forced default.
DO $$
DECLARE
  v_attnotnull BOOLEAN;
  v_default TEXT;
BEGIN
  SELECT a.attnotnull
    INTO v_attnotnull
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'fact_decisions'
    AND a.attname = 'episode_id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF COALESCE(v_attnotnull, FALSE) THEN
    ALTER TABLE fact_decisions
      ALTER COLUMN episode_id DROP NOT NULL;
  END IF;

  SELECT column_default
    INTO v_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'fact_decisions'
    AND column_name = 'episode_id';

  IF v_default IS NOT NULL THEN
    ALTER TABLE fact_decisions
      ALTER COLUMN episode_id DROP DEFAULT;
  END IF;
END $$;

-- Remove any stale FK on episode_id.
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
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'fact_decisions'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'episode_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE fact_decisions DROP CONSTRAINT IF EXISTS %I;',
      r.constraint_name
    );
  END LOOP;
END $$;

-- Verification output.
SELECT
  c.is_nullable,
  c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'fact_decisions'
  AND c.column_name = 'episode_id';

COMMIT;
