-- ============================================================
-- LAYERINFINITE — Migration 026: Add updated_at to dimension tables
-- ============================================================
-- Adds updated_at TIMESTAMPTZ column to all dimension tables
-- that are missing it. Also creates a schema_migrations table
-- and an auto-update trigger for each table.
--
-- Idempotent: all ADD COLUMN use IF NOT EXISTS.
-- ============================================================

-- ── 1. Add updated_at to all dimension tables ─────────────────

ALTER TABLE dim_agents
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE dim_customers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE dim_actions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE dim_contexts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill existing rows so updated_at = created_at (not NULL)
UPDATE dim_agents    SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE dim_customers SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE dim_actions   SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE dim_contexts  SET updated_at = created_at WHERE updated_at IS NULL;

-- ── 2. Trigger function: auto-set updated_at on every UPDATE ──

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Apply trigger to all 4 dimension tables ────────────────

DROP TRIGGER IF EXISTS trg_dim_agents_updated_at    ON dim_agents;
CREATE TRIGGER trg_dim_agents_updated_at
  BEFORE UPDATE ON dim_agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_dim_customers_updated_at ON dim_customers;
CREATE TRIGGER trg_dim_customers_updated_at
  BEFORE UPDATE ON dim_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_dim_actions_updated_at   ON dim_actions;
CREATE TRIGGER trg_dim_actions_updated_at
  BEFORE UPDATE ON dim_actions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_dim_contexts_updated_at  ON dim_contexts;
CREATE TRIGGER trg_dim_contexts_updated_at
  BEFORE UPDATE ON dim_contexts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 4. Schema migrations version tracking table ──────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TIMESTAMPTZ DEFAULT NOW(),
  description TEXT
);

-- Insert rows for every migration that has already been applied
-- (safe: ON CONFLICT DO NOTHING — idempotent on re-run)
INSERT INTO schema_migrations (version, description) VALUES
  (1,  '001_create_dimensions')
, (2,  '002_create_fact_outcomes')
, (3,  '003_create_episodes')
, (4,  '004_create_materialized_views')
, (5,  '005_create_indexes')
, (6,  '006_create_rls_policies')
, (7,  '007_create_trust_scores')
, (8,  '008_create_events')
, (9,  '009_add_matview_unique_indexes')
, (10, '010_create_helper_functions')
, (11, '011_create_cron_schedules')
, (12, '012_create_vector_index')
, (13, '013_create_auth_system')
, (14, '014_add_outcome_scoring')
, (15, '015_update_mv_outcome_score')
, (16, '016_add_latency_to_mv')
, (17, '017_update_alert_events')
, (18, '018_coordinated_failure_fn')
, (19, '019_create_fact_decisions')
, (20, '020_create_action_sequences')
, (21, '021_create_counterfactuals')
, (22, '022_create_world_model_artifacts')
, (23, '023_create_mv_sequence_scores')
, (24, '024_create_foundation_indexes')
, (25, '025_create_foundation_rls')
, (26, '026_add_updated_at_columns')
ON CONFLICT (version) DO NOTHING;
