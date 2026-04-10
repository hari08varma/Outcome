-- ============================================================
-- Migration 114: Extend recommendation cohort RPC with source labels
-- ============================================================
-- Purpose:
--   Persist opened confidence source labels in the same transaction
--   as cohort-cycle upsert/rotation.
--
-- Notes:
--   - Replaces the previous 6-arg RPC with an 8-arg signature.
--   - Last two args are optional (DEFAULT NULL) for compatibility.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS upsert_recommendation_cohort_cycle(
  UUID,
  TEXT,
  TIMESTAMPTZ,
  INTEGER,
  DOUBLE PRECISION,
  DOUBLE PRECISION
);

DROP FUNCTION IF EXISTS upsert_recommendation_cohort_cycle(
  UUID,
  TEXT,
  TIMESTAMPTZ,
  INTEGER,
  DOUBLE PRECISION,
  DOUBLE PRECISION,
  TEXT,
  TEXT
);

CREATE FUNCTION upsert_recommendation_cohort_cycle(
  p_customer_id UUID,
  p_task_name TEXT,
  p_observed_at TIMESTAMPTZ,
  p_total_outcomes INTEGER,
  p_median_confidence DOUBLE PRECISION,
  p_median_success_rate DOUBLE PRECISION,
  p_opened_confidence_source TEXT DEFAULT NULL,
  p_opened_confidence_source_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Canonical thresholds from implementation contract
  v_max_days CONSTANT DOUBLE PRECISION := 7;
  v_max_outcomes CONSTANT INTEGER := 100;
  v_conf_drop_threshold CONSTANT DOUBLE PRECISION := 0.10;
  v_success_drop_threshold CONSTANT DOUBLE PRECISION := 0.15;

  v_task_name TEXT;
  v_observed_at TIMESTAMPTZ;
  v_total_outcomes INTEGER;
  v_current_confidence DOUBLE PRECISION;
  v_current_success_rate DOUBLE PRECISION;
  v_opened_confidence_source TEXT;
  v_opened_confidence_source_reason TEXT;

  v_active recommendation_cohort_cycles%ROWTYPE;
  v_closed recommendation_cohort_cycles%ROWTYPE;
  v_new recommendation_cohort_cycles%ROWTYPE;

  v_elapsed_days DOUBLE PRECISION := 0;
  v_outcomes_in_cycle INTEGER := 0;
  v_confidence_drop DOUBLE PRECISION := NULL;
  v_success_rate_drop DOUBLE PRECISION := NULL;
  v_close_reason TEXT := NULL;
BEGIN
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'upsert_recommendation_cohort_cycle: p_customer_id is required';
  END IF;

  IF p_task_name IS NULL OR btrim(p_task_name) = '' THEN
    RAISE EXCEPTION 'upsert_recommendation_cohort_cycle: p_task_name is required';
  END IF;

  v_task_name := btrim(p_task_name);
  v_observed_at := COALESCE(p_observed_at, NOW());
  v_total_outcomes := GREATEST(COALESCE(p_total_outcomes, 0), 0);

  v_current_confidence := CASE
    WHEN p_median_confidence IS NULL THEN NULL
    ELSE LEAST(1, GREATEST(0, p_median_confidence))
  END;

  v_current_success_rate := CASE
    WHEN p_median_success_rate IS NULL THEN NULL
    ELSE LEAST(1, GREATEST(0, p_median_success_rate))
  END;

  v_opened_confidence_source := CASE lower(btrim(COALESCE(p_opened_confidence_source, '')))
    WHEN 'bootstrap' THEN 'bootstrap'
    WHEN 'empirical_warmup' THEN 'empirical_warmup'
    WHEN 'empirical_stable' THEN 'empirical_stable'
    WHEN 'hybrid_shadow' THEN 'hybrid_shadow'
    ELSE NULL
  END;

  v_opened_confidence_source_reason := NULLIF(btrim(COALESCE(p_opened_confidence_source_reason, '')), '');

  SELECT * INTO v_active
  FROM recommendation_cohort_cycles
  WHERE customer_id = p_customer_id
    AND task_name = v_task_name
    AND closed_at IS NULL
  ORDER BY opened_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO recommendation_cohort_cycles (
        customer_id,
        task_name,
        opened_at,
        opened_total_outcomes,
        opened_median_confidence,
        opened_median_success_rate,
        opened_confidence_source,
        opened_confidence_source_reason
      ) VALUES (
        p_customer_id,
        v_task_name,
        v_observed_at,
        v_total_outcomes,
        v_current_confidence,
        v_current_success_rate,
        v_opened_confidence_source,
        v_opened_confidence_source_reason
      )
      RETURNING * INTO v_new;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT * INTO v_new
        FROM recommendation_cohort_cycles
        WHERE customer_id = p_customer_id
          AND task_name = v_task_name
          AND closed_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1;
    END;

    RETURN jsonb_build_object(
      'active_cycle', jsonb_build_object(
        'cycle_id', v_new.cycle_id,
        'opened_at', v_new.opened_at,
        'closed_at', NULL,
        'close_reason', NULL,
        'elapsed_days', 0,
        'outcomes_in_cycle', 0,
        'opened_confidence_source', v_new.opened_confidence_source,
        'opened_confidence_source_reason', v_new.opened_confidence_source_reason
      ),
      'previous_cycle', NULL,
      'rotation_triggered', FALSE,
      'rotation_reason', NULL,
      'thresholds', jsonb_build_object(
        'max_days', v_max_days,
        'max_outcomes', v_max_outcomes,
        'confidence_drop', v_conf_drop_threshold,
        'success_rate_drop', v_success_drop_threshold
      )
    );
  END IF;

  v_elapsed_days := GREATEST(
    0,
    EXTRACT(EPOCH FROM (v_observed_at - v_active.opened_at)) / 86400.0
  );

  v_outcomes_in_cycle := GREATEST(
    0,
    v_total_outcomes - COALESCE(v_active.opened_total_outcomes, 0)
  );

  IF v_active.opened_median_confidence IS NOT NULL AND v_current_confidence IS NOT NULL THEN
    v_confidence_drop := ROUND((v_active.opened_median_confidence - v_current_confidence)::numeric, 4)::double precision;
  END IF;

  IF v_active.opened_median_success_rate IS NOT NULL AND v_current_success_rate IS NOT NULL THEN
    v_success_rate_drop := ROUND((v_active.opened_median_success_rate - v_current_success_rate)::numeric, 4)::double precision;
  END IF;

  -- Priority order mirrors API contract.
  IF v_confidence_drop IS NOT NULL AND v_confidence_drop >= v_conf_drop_threshold THEN
    v_close_reason := 'confidence_drop';
  ELSIF v_success_rate_drop IS NOT NULL AND v_success_rate_drop >= v_success_drop_threshold THEN
    v_close_reason := 'success_rate_drop';
  ELSIF v_outcomes_in_cycle >= v_max_outcomes THEN
    v_close_reason := 'outcome_count';
  ELSIF v_elapsed_days >= v_max_days THEN
    v_close_reason := 'time_elapsed';
  END IF;

  IF v_close_reason IS NULL THEN
    RETURN jsonb_build_object(
      'active_cycle', jsonb_build_object(
        'cycle_id', v_active.cycle_id,
        'opened_at', v_active.opened_at,
        'closed_at', NULL,
        'close_reason', NULL,
        'elapsed_days', ROUND(v_elapsed_days::numeric, 4)::double precision,
        'outcomes_in_cycle', v_outcomes_in_cycle,
        'opened_confidence_source', v_active.opened_confidence_source,
        'opened_confidence_source_reason', v_active.opened_confidence_source_reason
      ),
      'previous_cycle', NULL,
      'rotation_triggered', FALSE,
      'rotation_reason', NULL,
      'thresholds', jsonb_build_object(
        'max_days', v_max_days,
        'max_outcomes', v_max_outcomes,
        'confidence_drop', v_conf_drop_threshold,
        'success_rate_drop', v_success_drop_threshold
      )
    );
  END IF;

  UPDATE recommendation_cohort_cycles
  SET closed_at = v_observed_at,
      close_reason = v_close_reason
  WHERE cycle_id = v_active.cycle_id
  RETURNING * INTO v_closed;

  BEGIN
    INSERT INTO recommendation_cohort_cycles (
      customer_id,
      task_name,
      opened_at,
      opened_total_outcomes,
      opened_median_confidence,
      opened_median_success_rate,
      opened_confidence_source,
      opened_confidence_source_reason
    ) VALUES (
      p_customer_id,
      v_task_name,
      v_observed_at,
      v_total_outcomes,
      v_current_confidence,
      v_current_success_rate,
      v_opened_confidence_source,
      v_opened_confidence_source_reason
    )
    RETURNING * INTO v_new;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_new
      FROM recommendation_cohort_cycles
      WHERE customer_id = p_customer_id
        AND task_name = v_task_name
        AND closed_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1;
  END;

  RETURN jsonb_build_object(
    'active_cycle', jsonb_build_object(
      'cycle_id', v_new.cycle_id,
      'opened_at', v_new.opened_at,
      'closed_at', NULL,
      'close_reason', NULL,
      'elapsed_days', 0,
      'outcomes_in_cycle', 0,
      'opened_confidence_source', v_new.opened_confidence_source,
      'opened_confidence_source_reason', v_new.opened_confidence_source_reason
    ),
    'previous_cycle', jsonb_build_object(
      'cycle_id', v_closed.cycle_id,
      'opened_at', v_closed.opened_at,
      'closed_at', v_closed.closed_at,
      'close_reason', v_closed.close_reason,
      'elapsed_days', ROUND(v_elapsed_days::numeric, 4)::double precision,
      'outcomes_in_cycle', v_outcomes_in_cycle,
      'opened_confidence_source', v_closed.opened_confidence_source,
      'opened_confidence_source_reason', v_closed.opened_confidence_source_reason
    ),
    'rotation_triggered', TRUE,
    'rotation_reason', v_close_reason,
    'thresholds', jsonb_build_object(
      'max_days', v_max_days,
      'max_outcomes', v_max_outcomes,
      'confidence_drop', v_conf_drop_threshold,
      'success_rate_drop', v_success_drop_threshold
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_recommendation_cohort_cycle(
  UUID,
  TEXT,
  TIMESTAMPTZ,
  INTEGER,
  DOUBLE PRECISION,
  DOUBLE PRECISION,
  TEXT,
  TEXT
) TO service_role;

COMMIT;

-- Verification
SELECT routine_name, routine_type, security_type
FROM information_schema.routines
WHERE routine_name = 'upsert_recommendation_cohort_cycle'
  AND routine_schema = 'public';
