-- ════════════════════════════════════════════════════════════
-- Migration 073: Tenant merge via insert-copy (append-only safe)
-- Copies fact_outcomes rows from SDK tenant → dashboard tenant.
-- Uses INSERT ... SELECT with new outcome_id to avoid PK conflicts.
-- Safe to run multiple times — idempotent via NOT EXISTS guard.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ── Replace these two constants with your real UUIDs ─────────
-- SOURCE: the customer_id that has all the logged data (SDK key owner)
-- TARGET: the customer_id your dashboard session resolves to
DO $$
DECLARE
    source_uuid UUID := 'e5fee369-2b23-48e8-927f-2fd83783ea92';
    target_uuid UUID := 'df0c88a7-a9aa-4543-a6d5-84ae6847dea6';
    rows_copied  BIGINT;
BEGIN
    -- Guard: confirm source has data
    IF NOT EXISTS (
        SELECT 1 FROM fact_outcomes WHERE customer_id = source_uuid LIMIT 1
    ) THEN
        RAISE EXCEPTION 'SOURCE_UUID % has no rows in fact_outcomes. Check your UUID.', source_uuid;
    END IF;

    -- Guard: confirm target exists in dim_customers
    IF NOT EXISTS (
        SELECT 1 FROM dim_customers WHERE customer_id = target_uuid
    ) THEN
        RAISE EXCEPTION 'TARGET_UUID % does not exist in dim_customers. Check your UUID.', target_uuid;
    END IF;

    -- Guard: skip if target already has data (idempotent re-run protection)
    IF EXISTS (
        SELECT 1 FROM fact_outcomes WHERE customer_id = target_uuid LIMIT 1
    ) THEN
        RAISE NOTICE 'TARGET_UUID % already has rows. Skipping insert-copy. No changes made.', target_uuid;
        RETURN;
    END IF;

    -- Core insert-copy: new outcome_id to avoid PK conflict
    -- Copies only valid rows: non-null task_name, non-synthetic
    INSERT INTO fact_outcomes (
        outcome_id,
        agent_id,
        action_id,
        context_id,
        customer_id,
        session_id,
        timestamp,
        task_name,
        success,
        response_time_ms,
        error_code,
        error_message,
        raw_context,
        is_synthetic,
        is_deleted,
        deleted_at,
        salience_score,
        outcome_score,
        business_outcome,
        feedback_signal,
        feedback_received_at,
        verifier_source,
        verifier_value,
        discrepancy_detected,
        backprop_adjusted,
        backprop_episode_id,
        episode_id,
        signal_source,
        signal_confidence,
        causal_depth,
        signal_pending,
        signal_updated_at
    )
    SELECT
        gen_random_uuid(),   -- new PK — avoids any conflict
        agent_id,
        action_id,
        context_id,
        target_uuid,         -- ← this is the only column that changes
        session_id,
        timestamp,
        task_name,
        success,
        response_time_ms,
        error_code,
        error_message,
        raw_context,
        is_synthetic,
        is_deleted,
        deleted_at,
        salience_score,
        outcome_score,
        business_outcome,
        feedback_signal,
        feedback_received_at,
        verifier_source,
        verifier_value,
        discrepancy_detected,
        backprop_adjusted,
        backprop_episode_id,
        episode_id,
        signal_source,
        signal_confidence,
        causal_depth,
        signal_pending,
        signal_updated_at
    FROM fact_outcomes
    WHERE customer_id = source_uuid
      AND task_name IS NOT NULL
      AND trim(task_name) <> ''
      AND is_synthetic = FALSE;

    GET DIAGNOSTICS rows_copied = ROW_COUNT;
    RAISE NOTICE 'Tenant merge complete: % rows copied from % → %',
        rows_copied, source_uuid, target_uuid;
END $$;

-- ── Refresh MVs so dashboard sees the new data immediately ───
SELECT refresh_task_action_performance();

COMMIT;

-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run after migration)
-- ════════════════════════════════════════════════════════════

-- 1. Confirm target now has rows
SELECT
    customer_id,
    COUNT(*)                    AS total_rows,
    COUNT(DISTINCT task_name)   AS distinct_tasks
FROM fact_outcomes
WHERE customer_id = 'df0c88a7-a9aa-4543-a6d5-84ae6847dea6'
GROUP BY customer_id;
-- Expected: total_rows > 0, distinct_tasks >= 1

-- 2. Check MV has target tenant data
SELECT customer_id, task_name, COUNT(*) AS action_count
FROM mv_task_action_performance
WHERE customer_id = 'df0c88a7-a9aa-4543-a6d5-84ae6847dea6'
GROUP BY customer_id, task_name
ORDER BY action_count DESC;
-- Expected: rows for payment_failed and other tasks

-- 3. Check action diversity — which tasks are recommendation-ready
SELECT * FROM v_task_action_diversity
WHERE customer_id = 'df0c88a7-a9aa-4543-a6d5-84ae6847dea6'
ORDER BY recommendation_readiness, distinct_actions DESC;
-- Look for rows with recommendation_readiness = 'ready'

-- 4. Test the recommendations API
-- curl https://api.layerinfinite.app/v1/recommendations?task=payment_failed \
--   -H "Authorization: Bearer <your_sdk_key>"
-- Expected: state = "early_signal" or "stable" (not "no_data")
