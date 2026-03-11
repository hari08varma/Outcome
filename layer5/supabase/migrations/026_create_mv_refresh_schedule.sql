-- ============================================================
-- LAYER5 — Migration 026: Add mv_sequence_scores to Refresh Schedule
-- ============================================================
-- Adds mv_sequence_scores to the existing cron refresh schedule.
-- Uses REFRESH MATERIALIZED VIEW CONCURRENTLY (requires the
-- unique index created in migration 023).
--
-- The existing schedule (migration 011) refreshes via the
-- scoring-engine Edge Function. This migration adds:
--   1. A SECURITY DEFINER RPC function for the refresh
--   2. A pg_cron job that runs 30 seconds after the existing
--      mv_action_scores refresh (offset by running at :01 past)
--
-- Does NOT replace existing cron jobs — appends to them.
-- ============================================================

-- ────────────────────────────────────────────
-- RPC: refresh_mv_sequence_scores()
-- Same pattern as refresh_mv_action_scores() from migration 010
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_mv_sequence_scores()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start TIMESTAMPTZ := NOW();
  v_rows  BIGINT;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sequence_scores;
  SELECT COUNT(*) INTO v_rows FROM mv_sequence_scores;
  RETURN json_build_object(
    'success',      true,
    'rows',         v_rows,
    'duration_ms',  EXTRACT(EPOCH FROM (NOW() - v_start)) * 1000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object(
    'success', false,
    'error',   SQLERRM,
    'detail',  SQLSTATE
  );
END;
$$;

-- ────────────────────────────────────────────
-- Cron: refresh mv_sequence_scores
-- Runs at :01 past every 5 minutes (30-second offset
-- after the :00 scoring-engine refresh of mv_action_scores).
-- This ensures sequence scores are computed after action
-- scores are consistent.
-- ────────────────────────────────────────────
SELECT cron.schedule(
  'sequence-scores-refresh',
  '1-59/5 * * * *',
  $$SELECT refresh_mv_sequence_scores();$$
);
