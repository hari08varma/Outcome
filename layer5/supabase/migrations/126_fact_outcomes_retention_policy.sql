-- ============================================================
-- LAYERINFINITE — Migration 126: Fact Outcomes Retention Policy
-- ============================================================
-- Implements a production-grade data retention policy for fact_outcomes.
-- Deletes outcomes older than 30 days (default) in small chunks
-- to prevent long-running transaction locks and WAL spikes.
-- Explicitly deletes from referencing child tables first to bypass
-- cascading lock contention.
-- ============================================================

BEGIN;

-- 1. Create the chunked deletion function
CREATE OR REPLACE FUNCTION prune_historical_outcomes(days_to_keep int default 30, batch_size int default 5000)
RETURNS int AS $$
DECLARE
  target_date TIMESTAMPTZ;
  deleted_count int := 0;
  total_deleted int := 0;
  loop_count int := 0;
  max_loops int := 1000; -- safeguard to prevent infinite loop (max 5M rows per run)
BEGIN
  target_date := NOW() - (days_to_keep || ' days')::interval;
  
  LOOP
    -- We use a CTE to grab a chunk of outcome_ids, then explicitly delete from child tables
    -- before deleting from fact_outcomes. This avoids massive ON DELETE CASCADE
    -- lock contention on a highly active append-only table.
    WITH batch AS (
      SELECT outcome_id
      FROM fact_outcomes
      WHERE timestamp < target_date
      LIMIT batch_size
    ),
    del_idemp AS (
      DELETE FROM idempotency_keys
      WHERE outcome_id IN (SELECT outcome_id FROM batch)
    ),
    del_pending AS (
      DELETE FROM dim_pending_signal_registrations
      WHERE outcome_id IN (SELECT outcome_id FROM batch)
    ),
    del_discrep AS (
      DELETE FROM dim_discrepancy_log
      WHERE outcome_id IN (SELECT outcome_id FROM batch)
    ),
    del_decisions AS (
      DELETE FROM fact_decisions
      WHERE outcome_id IN (SELECT outcome_id FROM batch)
    ),
    del_counterfactuals AS (
      DELETE FROM counterfactuals
      WHERE outcome_id IN (SELECT outcome_id FROM batch)
    ),
    del_scores AS (
      DELETE FROM fact_outcome_scores
      WHERE outcome_id IN (SELECT outcome_id FROM batch)
    )
    DELETE FROM fact_outcomes
    WHERE outcome_id IN (SELECT outcome_id FROM batch);

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    total_deleted := total_deleted + deleted_count;
    loop_count := loop_count + 1;

    -- If we deleted fewer rows than the batch size, we have processed all old records
    EXIT WHEN deleted_count < batch_size;
    
    -- Safety exit to prevent cron from running for hours
    EXIT WHEN loop_count >= max_loops;
    
    -- Yield briefly to allow concurrent application traffic to acquire locks
    PERFORM pg_sleep(0.05);
  END LOOP;
  
  RETURN total_deleted;
END;
$$ LANGUAGE plpgsql;

-- 2. Schedule the cron job
-- Unschedule first if it exists (idempotency)
SELECT cron.unschedule('prune-fact-outcomes')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'prune-fact-outcomes'
  );

-- Schedule to run daily at 2:00 AM UTC
SELECT cron.schedule(
  'prune-fact-outcomes',
  '0 2 * * *',
  $$ SELECT prune_historical_outcomes(30, 5000); $$
);

COMMIT;
