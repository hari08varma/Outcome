-- Run this BEFORE migration 011.
-- If pg_cron is not enabled, migration 011 will 
-- silently fail and cron jobs will never run.

-- Step 1: Check if pg_cron is enabled
SELECT * FROM pg_extension WHERE extname = 'pg_cron';
-- Expected: 1 row
-- If 0 rows: Go to Supabase Dashboard → 
--   Database → Extensions → pg_cron → Enable
--   Then rerun this check before proceeding.

-- Step 2: Check if cron schema exists
SELECT schema_name FROM information_schema.schemata
WHERE schema_name = 'cron';
-- Expected: 1 row (if pg_cron enabled)

-- Step 3: Check existing cron jobs (after migration)
SELECT jobname, schedule, command
FROM cron.job
ORDER BY jobname;
-- Expected after migration 011:
--   refresh-scoring-cron     */5 * * * *
--   refresh-trust-cron       */5 * * * *
--   run-trend-detector-cron  0 2 * * *
--   run-pruning-cron         0 3 * * *
