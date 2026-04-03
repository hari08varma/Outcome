-- ============================================================
-- LAYERINFINITE — Migration 075: Fix /v1/log-outcome 500s
-- ============================================================
-- Root cause:
--   log-outcome.ts inserts extended metadata columns into fact_outcomes.
--   Some live databases are missing one or more of those columns, causing
--   INSERT_ERROR (column does not exist) and HTTP 500 responses.
--
-- Safety:
--   - Fully idempotent: all DDL uses IF NOT EXISTS.
--   - Backward compatible: new columns are nullable or defaulted.
--   - No destructive operations (no DROP/RENAME).
-- ============================================================

-- 1) Ensure all columns referenced by the log-outcome INSERT exist.
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS outcome_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS business_outcome VARCHAR(20),
  ADD COLUMN IF NOT EXISTS feedback_signal VARCHAR(20),
  ADD COLUMN IF NOT EXISTS verifier_source TEXT,
  ADD COLUMN IF NOT EXISTS verifier_value TEXT,
  ADD COLUMN IF NOT EXISTS discrepancy_detected BOOLEAN,
  ADD COLUMN IF NOT EXISTS backprop_episode_id UUID,
  ADD COLUMN IF NOT EXISTS episode_id UUID,
  ADD COLUMN IF NOT EXISTS signal_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS signal_confidence DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS causal_depth INTEGER,
  ADD COLUMN IF NOT EXISTS signal_pending BOOLEAN,
  ADD COLUMN IF NOT EXISTS signal_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS task_name VARCHAR(255);

-- 2) Set safe defaults so existing and future rows remain valid.
ALTER TABLE fact_outcomes
  ALTER COLUMN business_outcome SET DEFAULT 'unknown',
  ALTER COLUMN feedback_signal SET DEFAULT 'immediate',
  ALTER COLUMN discrepancy_detected SET DEFAULT FALSE,
  ALTER COLUMN signal_source SET DEFAULT 'explicit',
  ALTER COLUMN signal_pending SET DEFAULT FALSE,
  ALTER COLUMN task_name SET DEFAULT 'unknown_task';

-- 3) Backfill existing rows to avoid null-sensitive read paths.
UPDATE fact_outcomes
SET business_outcome = COALESCE(business_outcome, 'unknown'),
    feedback_signal = COALESCE(feedback_signal, 'immediate'),
    discrepancy_detected = COALESCE(discrepancy_detected, FALSE),
    signal_source = COALESCE(signal_source, 'explicit'),
    signal_pending = COALESCE(signal_pending, FALSE),
    task_name = CASE
      WHEN task_name IS NULL OR btrim(task_name) = '' THEN 'unknown_task'
      ELSE task_name
    END
WHERE business_outcome IS NULL
   OR feedback_signal IS NULL
   OR discrepancy_detected IS NULL
   OR signal_source IS NULL
   OR signal_pending IS NULL
   OR task_name IS NULL
   OR btrim(task_name) = '';

-- 4) Verification: list all columns required by log-outcome insert.
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'fact_outcomes'
  AND column_name IN (
    'outcome_score',
    'business_outcome',
    'feedback_signal',
    'verifier_source',
    'verifier_value',
    'discrepancy_detected',
    'backprop_episode_id',
    'episode_id',
    'signal_source',
    'signal_confidence',
    'causal_depth',
    'signal_pending',
    'signal_updated_at',
    'task_name'
  )
ORDER BY column_name;
