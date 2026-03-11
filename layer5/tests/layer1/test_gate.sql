-- ============================================================
-- LAYER5 — Phase 1 Test Gate
-- ============================================================
-- Run this script against your Supabase database AFTER
-- applying all Phase 1 migrations (001, 002, 003, 005, 006)
-- and seeding cold_start_priors.sql.
--
-- Every test must pass before proceeding to Phase 2.
-- ============================================================

-- ────────────────────────────────────────────
-- TEST 1: All expected tables exist
-- ────────────────────────────────────────────
DO $$
DECLARE
  expected_tables TEXT[] := ARRAY[
    'dim_agents', 'dim_actions', 'dim_contexts', 'dim_customers',
    'dim_institutional_knowledge',
    'fact_episodes', 'fact_outcomes', 'fact_outcomes_archive'
  ];
  missing TEXT[];
BEGIN
  SELECT ARRAY_AGG(t) INTO missing
  FROM UNNEST(expected_tables) AS t
  WHERE t NOT IN (
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
  );

  IF missing IS NOT NULL AND array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'TEST 1 FAILED — Missing tables: %', missing;
  ELSE
    RAISE NOTICE 'TEST 1 PASSED — All 8 expected tables exist';
  END IF;
END $$;

-- ────────────────────────────────────────────
-- TEST 2: fact_outcomes has correct columns and types
-- ────────────────────────────────────────────
DO $$
DECLARE
  col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_name = 'fact_outcomes'
    AND table_schema = 'public';

  IF col_count < 15 THEN
    RAISE EXCEPTION 'TEST 2 FAILED — fact_outcomes has only % columns (expected >= 15)', col_count;
  END IF;

  -- Verify critical column types
  PERFORM 1 FROM information_schema.columns
  WHERE table_name = 'fact_outcomes'
    AND column_name = 'outcome_id'
    AND data_type = 'uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 2 FAILED — outcome_id is not UUID type';
  END IF;

  PERFORM 1 FROM information_schema.columns
  WHERE table_name = 'fact_outcomes'
    AND column_name = 'timestamp'
    AND data_type = 'timestamp with time zone';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 2 FAILED — timestamp is not TIMESTAMPTZ';
  END IF;

  PERFORM 1 FROM information_schema.columns
  WHERE table_name = 'fact_outcomes'
    AND column_name = 'success'
    AND is_nullable = 'NO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 2 FAILED — success column should be NOT NULL';
  END IF;

  RAISE NOTICE 'TEST 2 PASSED — fact_outcomes has correct columns and types';
END $$;

-- ────────────────────────────────────────────
-- TEST 3: Append-only trigger raises EXCEPTION on UPDATE
-- (This test expects the trigger to block the UPDATE)
-- ────────────────────────────────────────────
DO $$
DECLARE
  trigger_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'enforce_append_only'
      AND event_object_table = 'fact_outcomes'
  ) INTO trigger_exists;

  IF NOT trigger_exists THEN
    RAISE EXCEPTION 'TEST 3 FAILED — enforce_append_only trigger does not exist on fact_outcomes';
  ELSE
    RAISE NOTICE 'TEST 3 PASSED — enforce_append_only trigger exists on fact_outcomes';
  END IF;
END $$;

-- Manual verification step (run separately — this WILL error, which is correct):
-- INSERT a test row, then try to UPDATE it:
--   INSERT INTO fact_outcomes(agent_id, action_id, context_id, customer_id, session_id, success)
--   VALUES ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
--           'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
--           gen_random_uuid(), TRUE);
--   UPDATE fact_outcomes SET success = FALSE WHERE agent_id = 'd0000000-0000-0000-0000-000000000001';
-- Expected: ERROR "fact_outcomes is APPEND-ONLY..."

-- ────────────────────────────────────────────
-- TEST 4: All fact_outcomes indexes exist
-- ────────────────────────────────────────────
DO $$
DECLARE
  idx_count INT;
BEGIN
  SELECT COUNT(*) INTO idx_count
  FROM pg_indexes
  WHERE tablename = 'fact_outcomes'
    AND schemaname = 'public';

  -- 6 custom indexes + 1 PK index = 7 total
  IF idx_count < 7 THEN
    RAISE EXCEPTION 'TEST 4 FAILED — fact_outcomes has only % indexes (expected >= 7)', idx_count;
  ELSE
    RAISE NOTICE 'TEST 4 PASSED — fact_outcomes has % indexes', idx_count;
  END IF;
END $$;

-- ────────────────────────────────────────────
-- TEST 5: RLS is enabled on customer-scoped tables
-- ────────────────────────────────────────────
DO $$
DECLARE
  rls_tables TEXT[] := ARRAY[
    'fact_outcomes', 'fact_episodes', 'fact_outcomes_archive',
    'dim_agents', 'dim_customers', 'dim_actions', 'dim_contexts',
    'dim_institutional_knowledge'
  ];
  missing_rls TEXT[];
BEGIN
  SELECT ARRAY_AGG(t) INTO missing_rls
  FROM UNNEST(rls_tables) AS t
  WHERE t NOT IN (
    SELECT tablename::TEXT FROM pg_tables
    WHERE schemaname = 'public' AND rowsecurity = TRUE
  );

  IF missing_rls IS NOT NULL AND array_length(missing_rls, 1) > 0 THEN
    RAISE EXCEPTION 'TEST 5 FAILED — RLS not enabled on: %', missing_rls;
  ELSE
    RAISE NOTICE 'TEST 5 PASSED — RLS enabled on all expected tables';
  END IF;
END $$;

-- ────────────────────────────────────────────
-- TEST 6: Seed data loaded correctly
-- ────────────────────────────────────────────
DO $$
DECLARE
  customer_count INT;
  action_count INT;
  context_count INT;
  agent_count INT;
  knowledge_count INT;
BEGIN
  SELECT COUNT(*) INTO customer_count FROM dim_customers;
  SELECT COUNT(*) INTO action_count FROM dim_actions;
  SELECT COUNT(*) INTO context_count FROM dim_contexts;
  SELECT COUNT(*) INTO agent_count FROM dim_agents;
  SELECT COUNT(*) INTO knowledge_count FROM dim_institutional_knowledge;

  IF customer_count < 1 THEN RAISE EXCEPTION 'TEST 6 FAILED — No customers seeded'; END IF;
  IF action_count < 8 THEN RAISE EXCEPTION 'TEST 6 FAILED — Expected >= 8 actions, got %', action_count; END IF;
  IF context_count < 5 THEN RAISE EXCEPTION 'TEST 6 FAILED — Expected >= 5 contexts, got %', context_count; END IF;
  IF agent_count < 1 THEN RAISE EXCEPTION 'TEST 6 FAILED — No agents seeded'; END IF;
  IF knowledge_count < 12 THEN RAISE EXCEPTION 'TEST 6 FAILED — Expected >= 12 institutional knowledge rows, got %', knowledge_count; END IF;

  RAISE NOTICE 'TEST 6 PASSED — Seed data loaded: % customers, % actions, % contexts, % agents, % knowledge rows',
    customer_count, action_count, context_count, agent_count, knowledge_count;
END $$;

-- ────────────────────────────────────────────
-- TEST 7: Required extensions are active
-- ────────────────────────────────────────────
DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'vector';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST 7 FAILED — pgvector extension not enabled';
  END IF;

  RAISE NOTICE 'TEST 7 PASSED — All required extensions are active';
END $$;

-- ────────────────────────────────────────────
-- TEST 8: FK constraints are correct
-- ────────────────────────────────────────────
DO $$
DECLARE
  fk_count INT;
BEGIN
  SELECT COUNT(*) INTO fk_count
  FROM information_schema.table_constraints
  WHERE table_name = 'fact_outcomes'
    AND constraint_type = 'FOREIGN KEY';

  -- agent_id, action_id, context_id, customer_id = 4 FKs
  IF fk_count < 4 THEN
    RAISE EXCEPTION 'TEST 8 FAILED — fact_outcomes has only % FK constraints (expected 4)', fk_count;
  ELSE
    RAISE NOTICE 'TEST 8 PASSED — fact_outcomes has % FK constraints', fk_count;
  END IF;
END $$;

-- ════════════════════════════════════════════
-- ALL TESTS COMPLETE
-- If no exceptions were raised, Phase 1 passes.
-- ════════════════════════════════════════════
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════';
  RAISE NOTICE 'PHASE 1 TEST GATE — ALL TESTS PASSED ✓';
  RAISE NOTICE '════════════════════════════════════════════';
  RAISE NOTICE 'Ready to proceed to Phase 2.';
  RAISE NOTICE 'Commit: git commit -m "feat: layer-1 complete"';
END $$;
