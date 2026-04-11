-- ============================================================================
-- Backfill Execution Script for Migration 104
-- Run this AFTER migration 104 has been applied (functions created).
--
-- STEP-BY-STEP:
--   1. Preview candidates (read-only)
--   2. Dry-run with audit
--   3. Review audit rows
--   4. Apply (explicit opt-in)
--   5. Refresh materialized views
--
-- WARNING: Step 4 mutates data. Run during a maintenance window.
-- ============================================================================

-- ── Step 1: Preview candidates (read-only) ───────────────────
-- Lists all raw→canonical merge candidates without making any changes.
-- Review this output to understand the scope of the backfill.
SELECT * FROM preview_fragmented_action_merges(NULL) LIMIT 200;

-- ── Step 2: Dry-run with audit (read-only + audit rows) ──────
-- Creates audit records in action_fragmentation_backfill_runs/details
-- but does NOT modify fact_outcomes or fact_decisions.
-- SELECT * FROM backfill_fragmented_actions(NULL, true, 500000);

-- ── Step 3: Review audit rows ────────────────────────────────
-- After dry-run, inspect what would be changed:
-- SELECT * FROM action_fragmentation_backfill_runs ORDER BY started_at DESC LIMIT 5;
-- SELECT * FROM action_fragmentation_backfill_details WHERE run_id = '<run_id from above>' ORDER BY outcome_rows DESC;

-- ── Step 4: Apply (DESTRUCTIVE — opt-in) ─────────────────────
-- UNCOMMENT THE NEXT LINE ONLY AFTER reviewing Step 2+3 output.
-- This rewrites action_id in fact_outcomes and fact_decisions.
-- SELECT * FROM backfill_fragmented_actions(NULL, false, 500000);

-- ── Step 5: Refresh materialized views ───────────────────────
-- After applying, force a refresh so downstream reads see merged data:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_task_action_performance_180d;
-- SELECT refresh_cluster_scores();  -- migration 118
