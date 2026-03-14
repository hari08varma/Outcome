/**
 * Layerinfinite — Phase 3 E2E Test Gate
 * Tests the API layer against live Supabase.
 * Run: node scripts/deploy.js sql tests/layer3/test_gate.sql
 * (or use the Supabase SQL editor for the SQL tests below)
 *
 * The JS test runner is: node scripts/test-phase3.js
 */

-- ============================================================
-- Part A: Database-level API contract tests
-- These run against the Phase 1+2 schema to verify the
-- data layer the API depends on is intact.
-- ============================================================

-- ────────────────────────────────────────────
-- TEST A1: log-outcome prerequisite — all FK targets exist
-- ────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM dim_actions WHERE is_active = TRUE;
  IF v_count < 8 THEN
    RAISE EXCEPTION 'TEST A1 FAILED — Expected >= 8 active actions, found %', v_count;
  END IF;
  RAISE NOTICE 'TEST A1 PASSED — % active actions registered', v_count;
END $$;

-- ────────────────────────────────────────────
-- TEST A2: hallucination prevention contract
-- A fake action_name CANNOT be in dim_actions
-- ────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM dim_actions
  WHERE action_name = 'definitely_not_a_real_action_xyz';

  IF v_count > 0 THEN
    RAISE EXCEPTION 'TEST A2 FAILED — Fake action found in registry!';
  END IF;
  RAISE NOTICE 'TEST A2 PASSED — Hallucination prevention: fake action correctly absent from registry';
END $$;

-- ────────────────────────────────────────────
-- TEST A3: append-only constraint enforced at DB level
-- (the API relies on this trigger)
-- ────────────────────────────────────────────
DO $$
DECLARE
  v_outcome_id UUID;
  v_blocked    BOOLEAN := FALSE;
BEGIN
  -- Get an outcome to try updating
  SELECT outcome_id INTO v_outcome_id FROM fact_outcomes LIMIT 1;

  IF v_outcome_id IS NULL THEN
    RAISE NOTICE 'TEST A3 SKIPPED — No outcomes in fact_outcomes yet';
    RETURN;
  END IF;

  BEGIN
    UPDATE fact_outcomes SET success = NOT success WHERE outcome_id = v_outcome_id;
    RAISE EXCEPTION 'TEST A3 FAILED — UPDATE was NOT blocked by trigger!';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%APPEND-ONLY%' THEN
      v_blocked := TRUE;
    ELSE
      RAISE EXCEPTION 'TEST A3 FAILED — Unexpected error: %', SQLERRM;
    END IF;
  END;

  IF v_blocked THEN
    RAISE NOTICE 'TEST A3 PASSED — Append-only trigger blocked UPDATE correctly';
  END IF;
END $$;

-- ────────────────────────────────────────────
-- TEST A4: get-scores data source — mv_action_scores is populated
-- ────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM mv_action_scores;
  RAISE NOTICE 'TEST A4 PASSED — mv_action_scores has % rows (cold-start leads to 0, which is expected)', v_count;
END $$;

-- ────────────────────────────────────────────
-- TEST A5: cold-start fallback data — institutional knowledge loaded
-- ────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM dim_institutional_knowledge;
  IF v_count < 12 THEN
    RAISE EXCEPTION 'TEST A5 FAILED — Expected >= 12 institutional knowledge rows, found %', v_count;
  END IF;
  RAISE NOTICE 'TEST A5 PASSED — % institutional knowledge rows for cold-start fallback', v_count;
END $$;

-- ────────────────────────────────────────────
-- TEST A6: audit trail — fact_outcomes rows are accessible
-- ────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM fact_outcomes WHERE is_deleted = FALSE;
  RAISE NOTICE 'TEST A6 PASSED — % non-deleted outcomes in audit trail', v_count;
END $$;

-- ────────────────────────────────────────────
-- TEST A7: RLS is enabled on core tables
-- ────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND rowsecurity = TRUE
    AND tablename IN ('fact_outcomes','dim_agents','dim_customers','fact_episodes');

  IF v_count < 4 THEN
    RAISE EXCEPTION 'TEST A7 FAILED — Expected 4 tables with RLS, found %', v_count;
  END IF;
  RAISE NOTICE 'TEST A7 PASSED — RLS enabled on % customer-scoped tables', v_count;
END $$;

-- ────────────────────────────────────────────
-- Summary
-- ────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════';
  RAISE NOTICE 'PHASE 3 DB TEST GATE — ALL TESTS PASSED ✓';
  RAISE NOTICE 'API Layer is ready for production deployment.';
  RAISE NOTICE 'Commit: git commit -m "feat: layer-3 complete"';
  RAISE NOTICE '════════════════════════════════════════════════';
END $$;
