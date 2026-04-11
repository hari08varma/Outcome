-- ============================================================
-- LAYERINFINITE -- Migration 116: fact_outcomes task/source composite index
-- ============================================================
-- Purpose:
--   Improve selective scans for task-scoped agent queries that filter by
--   customer_id + agent_id + task_name and optionally ingestion_source.
--
-- Notes:
--   - Added as a new migration (do not edit historical migration 105).
--   - Keeps index narrow with partial predicate for live rows only.
-- ============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_customer_agent_task_source
    ON fact_outcomes (
        customer_id,
        agent_id,
        task_name,
        ingestion_source,
        timestamp DESC
    )
    WHERE is_deleted = false
      AND is_synthetic = false
      AND task_name IS NOT NULL;

COMMIT;

-- Verification
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_fact_outcomes_customer_agent_task_source';
