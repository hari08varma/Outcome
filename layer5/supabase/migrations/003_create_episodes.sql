-- ============================================================
-- LAYERINFINITE — Migration 003: Episodes, Archive & Institutional Knowledge
-- ============================================================
-- Creates the hierarchical memory tables:
--   fact_episodes             — Level 2 episodic memory
--   fact_outcomes_archive     — Warm storage (90–365 days)
--   dim_institutional_knowledge — Cross-customer patterns (retained forever)
-- ============================================================

-- ────────────────────────────────────────────
-- FACT TABLE 2: Episode Memory (Hierarchical Level 2)
-- Groups all actions from one session into a
-- single episode with aggregate metrics.
-- ────────────────────────────────────────────
CREATE TABLE fact_episodes (
  episode_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL UNIQUE,
  agent_id          UUID NOT NULL REFERENCES dim_agents(agent_id),
  context_id        UUID NOT NULL REFERENCES dim_contexts(context_id),
  customer_id       UUID NOT NULL REFERENCES dim_customers(customer_id),
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  total_actions     INTEGER DEFAULT 0,
  successful_actions INTEGER DEFAULT 0,
  episode_success   BOOLEAN,                  -- did the episode resolve the issue?
  resolution_action_id UUID REFERENCES dim_actions(action_id),
  duration_ms       INTEGER,
  action_sequence   JSONB DEFAULT '[]'        -- ordered list of actions taken
);

-- ────────────────────────────────────────────
-- FACT TABLE 3: Outcome Archive (Warm Storage)
-- Compressed aggregate records for 90–365 day
-- retention window. 100:1 compression ratio.
-- ────────────────────────────────────────────
CREATE TABLE fact_outcomes_archive (
  archive_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES dim_agents(agent_id),
  action_id         UUID NOT NULL REFERENCES dim_actions(action_id),
  context_id        UUID NOT NULL REFERENCES dim_contexts(context_id),
  customer_id       UUID NOT NULL REFERENCES dim_customers(customer_id),
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  total_outcomes    INTEGER NOT NULL DEFAULT 0,
  total_successes   INTEGER NOT NULL DEFAULT 0,
  avg_response_time_ms FLOAT,
  avg_success_rate  FLOAT,
  compression_ratio INTEGER DEFAULT 1,        -- how many raw records this represents
  sample_count      INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────
-- DIMENSION TABLE 5: Institutional Knowledge
-- Cross-customer anonymized patterns.
-- Retained forever — Layerinfinite's network effect moat.
-- ────────────────────────────────────────────
CREATE TABLE dim_institutional_knowledge (
  pattern_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id         UUID REFERENCES dim_actions(action_id),
  context_type      VARCHAR(255) NOT NULL,    -- e.g. "payment_failed"
  industry          VARCHAR(100),
  avg_success_rate  FLOAT NOT NULL DEFAULT 0.0,
  sample_count      INTEGER NOT NULL DEFAULT 0,
  last_updated      TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
