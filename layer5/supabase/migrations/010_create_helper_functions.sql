-- ============================================================
-- LAYERINFINITE — Helper RPC Functions for Edge Function
-- ============================================================
-- The scoring-engine Edge Function calls these via supabase.rpc()
-- so the REFRESH happens inside a SECURITY DEFINER function
-- with proper permissions, called from the edge runtime.
-- ============================================================

-- Refresh mv_action_scores (called every 5 min by scoring-engine)
CREATE OR REPLACE FUNCTION refresh_mv_action_scores()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start TIMESTAMPTZ := NOW();
  v_rows  BIGINT;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
  SELECT COUNT(*) INTO v_rows FROM mv_action_scores;
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

-- Refresh mv_episode_patterns (called nightly by scoring-engine)
CREATE OR REPLACE FUNCTION refresh_mv_episode_patterns()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start TIMESTAMPTZ := NOW();
  v_rows  BIGINT;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_episode_patterns;
  SELECT COUNT(*) INTO v_rows FROM mv_episode_patterns;
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
