CREATE OR REPLACE FUNCTION refresh_action_scores()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'refresh_action_scores: failed to refresh mv_action_scores: %', SQLERRM;
END;
$$;
