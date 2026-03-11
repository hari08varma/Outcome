-- ============================================================
-- LAYER5 — Migration 001: Dimension Tables
-- ============================================================
-- Creates all dimension tables in dependency order.
-- RULES: All PKs are UUID. All timestamps are TIMESTAMPTZ.
-- ============================================================

-- Ensure required extensions are active
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ────────────────────────────────────────────
-- DIMENSION TABLE 1: Customer Registry
-- Created FIRST — all other tables FK to this
-- ────────────────────────────────────────────
CREATE TABLE dim_customers (
  customer_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name      VARCHAR(255) NOT NULL,
  industry          VARCHAR(100),
  tier              VARCHAR(50) DEFAULT 'pro',
  api_key_hash      VARCHAR(255),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  pruning_config    JSONB DEFAULT '{
    "max_records_per_action": 1000,
    "cold_storage_after_days": 90,
    "delete_after_days": 365,
    "min_score_to_keep": 0.01
  }',
  config            JSONB DEFAULT '{
    "role": "customer_admin",
    "risk_tolerance": "balanced",
    "min_confidence": 0.5,
    "escalation_score": 0.2,
    "exploration_rate": 0.05
  }'
);

-- ────────────────────────────────────────────
-- DIMENSION TABLE 2: Agent Registry
-- ────────────────────────────────────────────
CREATE TABLE dim_agents (
  agent_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name        VARCHAR(255) NOT NULL,
  agent_type        VARCHAR(100) NOT NULL,    -- support/payment/onboarding/custom
  llm_model         VARCHAR(100),             -- gpt-4/claude/gemini/custom
  customer_id       UUID NOT NULL REFERENCES dim_customers(customer_id),
  api_key_hash      VARCHAR(255),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  is_active         BOOLEAN DEFAULT TRUE,
  config            JSONB DEFAULT '{}'
);

-- ────────────────────────────────────────────
-- DIMENSION TABLE 3: Action Registry
-- Hallucination Prevention — only registered
-- actions can be logged to fact_outcomes
-- ────────────────────────────────────────────
CREATE TABLE dim_actions (
  action_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_name       VARCHAR(255) UNIQUE NOT NULL,
  action_category   VARCHAR(100),             -- recovery/escalation/automation
  action_description TEXT,
  required_params   JSONB DEFAULT '{}',       -- schema for param validation
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────
-- DIMENSION TABLE 4: Context Registry
-- ────────────────────────────────────────────
CREATE TABLE dim_contexts (
  context_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_type        VARCHAR(255) NOT NULL,    -- payment_failed/timeout/auth_error
  environment       VARCHAR(50) DEFAULT 'production',
  customer_tier     VARCHAR(50),              -- free/pro/enterprise
  time_of_day       VARCHAR(20),              -- morning/afternoon/evening/night
  day_of_week       INTEGER,                  -- 0=Monday, 6=Sunday
  context_vector    VECTOR(1536),             -- embedding for similarity matching
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
