-- ============================================================
-- LAYER5 — Test Gate: Phase 2
-- ============================================================
-- Run after applying migrations 004 and 009 and seeding data.
-- All tests must pass before proceeding to Phase 3.
-- ============================================================

-- ────────────────────────────────────────────
-- TEST 1: Materialized views exist
-- ────────────────────────────────────────────
DO $$
BEGIN
  PERFORM 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'mv_action_scores';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 1 FAILED — mv_action_scores does not exist';
  END IF;
  PERFORM 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'mv_episode_patterns';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 1 FAILED — mv_episode_patterns does not exist';
  END IF;
  RAISE NOTICE 'TEST 1 PASSED — Both materialized views exist';
END $$;

-- ────────────────────────────────────────────
-- TEST 2: UNIQUE indexes exist on both views
-- ────────────────────────────────────────────
DO $$
BEGIN
  PERFORM 1 FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'mv_action_scores'
    AND indexname = 'ux_action_scores_composite';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 2 FAILED — ux_action_scores_composite index missing (required for CONCURRENTLY)';
  END IF;

  PERFORM 1 FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'mv_episode_patterns'
    AND indexname = 'ux_episode_patterns_composite';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 2 FAILED — ux_episode_patterns_composite index missing (required for CONCURRENTLY)';
  END IF;

  RAISE NOTICE 'TEST 2 PASSED — UNIQUE indexes present on both views';
END $$;

-- ────────────────────────────────────────────
-- TEST 3: Insert test data, refresh, verify aggregation
-- ────────────────────────────────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  -- Insert 4 test outcomes: 3 successes, 1 failure
  INSERT INTO fact_outcomes(agent_id, action_id, context_id, customer_id, session_id, success, is_synthetic)
  VALUES
    ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003',
     'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
     gen_random_uuid(), TRUE, FALSE),
    ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003',
     'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
     gen_random_uuid(), TRUE, FALSE),
    ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003',
     'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
     gen_random_uuid(), TRUE, FALSE),
    ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003',
     'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
     gen_random_uuid(), FALSE, FALSE);

  -- Refresh the view
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;

  -- Verify aggregation: 3/4 = 0.75 raw_success_rate
  SELECT COUNT(*) INTO v_count
  FROM mv_action_scores
  WHERE action_id = 'b0000000-0000-0000-0000-000000000003'
    AND context_id = 'c0000000-0000-0000-0000-000000000001'
    AND customer_id = 'a0000000-0000-0000-0000-000000000001'
    AND raw_success_rate = 0.75;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'TEST 3 FAILED — Expected raw_success_rate=0.75, but not found in view';
  END IF;

  RAISE NOTICE 'TEST 3 PASSED — Aggregation correct: 3 successes + 1 failure = 0.75 success rate';
END $$;

-- ────────────────────────────────────────────
-- TEST 4: Confidence formula at known sample sizes
-- ────────────────────────────────────────────
DO $$
DECLARE
  v_confidence NUMERIC;
BEGIN
  SELECT confidence INTO v_confidence
  FROM mv_action_scores
  WHERE action_id = 'b0000000-0000-0000-0000-000000000003'
    AND context_id = 'c0000000-0000-0000-0000-000000000001'
    AND customer_id = 'a0000000-0000-0000-0000-000000000001';

  -- n=4: confidence = 4/(4+10) = 0.2857 ≈ 0.286 (±0.01)
  IF v_confidence IS NULL OR v_confidence < 0.28 OR v_confidence > 0.30 THEN
    RAISE EXCEPTION 'TEST 4 FAILED — confidence=% expected ~0.286 for n=4', v_confidence;
  END IF;

  RAISE NOTICE 'TEST 4 PASSED — Confidence formula correct: n=4 → confidence=%', v_confidence;
END $$;

-- ────────────────────────────────────────────
-- TEST 5: is_synthetic=TRUE rows excluded from view
-- ────────────────────────────────────────────
DO $$
DECLARE
  v_before INT;
  v_after INT;
BEGIN
  SELECT total_attempts INTO v_before FROM mv_action_scores
  WHERE action_id = 'b0000000-0000-0000-0000-000000000003'
    AND context_id = 'c0000000-0000-0000-0000-000000000001';

  -- Insert a synthetic row (should NOT appear in view)
  INSERT INTO fact_outcomes(agent_id, action_id, context_id, customer_id, session_id, success, is_synthetic)
  VALUES (
    'd0000000-0000-0000-0000-000000000001',
    'b0000000-0000-0000-0000-000000000003',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    gen_random_uuid(), TRUE, TRUE  -- is_synthetic = TRUE
  );

  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;

  SELECT total_attempts INTO v_after FROM mv_action_scores
  WHERE action_id = 'b0000000-0000-0000-0000-000000000003'
    AND context_id = 'c0000000-0000-0000-0000-000000000001';

  IF v_after != v_before THEN
    RAISE EXCEPTION 'TEST 5 FAILED — is_synthetic=TRUE row was included in view (before=%, after=%)', v_before, v_after;
  END IF;

  RAISE NOTICE 'TEST 5 PASSED — Synthetic rows correctly excluded from mv_action_scores';
END $$;

-- ────────────────────────────────────────────
-- TEST 6: CONCURRENTLY refresh works without lock error
-- ────────────────────────────────────────────
DO $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;
  RAISE NOTICE 'TEST 6 PASSED — REFRESH MATERIALIZED VIEW CONCURRENTLY works (no lock error)';
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'TEST 6 FAILED — CONCURRENTLY refresh failed: %', SQLERRM;
END $$;

-- ────────────────────────────────────────────
-- TEST 7: Helper RPC functions exist
-- ────────────────────────────────────────────
DO $$
BEGIN
  PERFORM 1 FROM pg_proc
  WHERE proname = 'refresh_mv_action_scores' AND pronamespace = 'public'::regnamespace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 7 FAILED — refresh_mv_action_scores RPC function not found';
  END IF;
  RAISE NOTICE 'TEST 7 PASSED — Helper RPC functions exist';
END $$;

-- ════════════════════════════════════════════
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════';
  RAISE NOTICE 'PHASE 2 TEST GATE — ALL TESTS PASSED ✓';
  RAISE NOTICE '════════════════════════════════════════════';
  RAISE NOTICE 'Ready to proceed to Phase 3.';
  RAISE NOTICE 'Commit: git commit -m "feat: layer-2 complete"';
END $$;
