-- ============================================================
-- LAYERINFINITE — Migration 005: All Indexes (IDEMPOTENT)
-- ============================================================
-- CRITICAL: All indexes MUST be created BEFORE any data
-- is written. Creating indexes after data load = potential
-- hours of downtime on production.
-- Using IF NOT EXISTS for idempotent re-runs.
-- ============================================================

-- ────────────────────────────────────────────
-- fact_outcomes indexes
-- ────────────────────────────────────────────
-- Primary query pattern: agent + context + time descending
CREATE INDEX IF NOT EXISTS idx_outcomes_agent_context_ts
  ON fact_outcomes(agent_id, context_id, timestamp DESC)
  WHERE is_deleted = FALSE;

-- Scoring aggregation: action + context
CREATE INDEX IF NOT EXISTS idx_outcomes_action_context
  ON fact_outcomes(action_id, context_id)
  WHERE is_deleted = FALSE;

-- Episode grouping
CREATE INDEX IF NOT EXISTS idx_outcomes_session
  ON fact_outcomes(session_id);

-- Time-range queries (audit, pruning)
CREATE INDEX IF NOT EXISTS idx_outcomes_timestamp
  ON fact_outcomes(timestamp DESC);

-- Customer-scoped time queries
CREATE INDEX IF NOT EXISTS idx_outcomes_customer_ts
  ON fact_outcomes(customer_id, timestamp DESC)
  WHERE is_deleted = FALSE;

-- Synthetic prior identification (cold start queries)
CREATE INDEX IF NOT EXISTS idx_outcomes_synthetic
  ON fact_outcomes(is_synthetic)
  WHERE is_synthetic = TRUE;

-- ────────────────────────────────────────────
-- dim_actions indexes
-- ────────────────────────────────────────────
-- Hallucination prevention: fast lookup by action_name
CREATE INDEX IF NOT EXISTS idx_actions_name
  ON dim_actions(action_name)
  WHERE is_active = TRUE;

-- ────────────────────────────────────────────
-- dim_contexts indexes
-- ────────────────────────────────────────────
-- Exact match on issue_type (fallback when embeddings unavailable)
CREATE INDEX IF NOT EXISTS idx_contexts_issue_type
  ON dim_contexts(issue_type);

-- NOTE: pgvector IVFFlat index requires at least a few hundred
-- rows to be useful. Create manually after seeding:
-- CREATE INDEX idx_contexts_vector
--   ON dim_contexts USING ivfflat (context_vector vector_cosine_ops);

-- ────────────────────────────────────────────
-- fact_episodes indexes
-- ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_episodes_agent_context
  ON fact_episodes(agent_id, context_id);

CREATE INDEX IF NOT EXISTS idx_episodes_customer
  ON fact_episodes(customer_id);

CREATE INDEX IF NOT EXISTS idx_episodes_started_at
  ON fact_episodes(started_at DESC);

-- ────────────────────────────────────────────
-- fact_outcomes_archive indexes
-- ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_archive_customer_period
  ON fact_outcomes_archive(customer_id, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_archive_action_context
  ON fact_outcomes_archive(action_id, context_id);

-- ────────────────────────────────────────────
-- dim_institutional_knowledge indexes
-- ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_institutional_context_type
  ON dim_institutional_knowledge(context_type);

CREATE INDEX IF NOT EXISTS idx_institutional_action
  ON dim_institutional_knowledge(action_id);
