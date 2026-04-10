-- ============================================================
-- LAYERINFINITE — Migration 109: Import near-duplicate lookup index
-- ============================================================
-- Why:
--   ingest-core near-duplicate suppression queries recent import rows by
--   customer/agent/action/context/task/success within a narrow timestamp
--   window. This partial index keeps lookup latency bounded at scale.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_import_near_dedup
    ON fact_outcomes (
        customer_id,
        agent_id,
        action_id,
        context_id,
        task_name,
        success,
        timestamp DESC
    )
    WHERE ingestion_source = 'import'
      AND is_deleted = false
      AND is_synthetic = false;
