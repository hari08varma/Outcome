-- ============================================================
-- LAYERINFINITE — Migration 002: Fact Outcomes (APPEND-ONLY)
-- ============================================================
-- CRITICAL: This table is APPEND-ONLY.
-- A BEFORE UPDATE trigger enforces this with a loud EXCEPTION.
-- NEVER UPDATE any row. Use is_deleted=TRUE for soft deletes
-- via INSERT of a new record (or operational query filtering).
-- ============================================================

CREATE TABLE fact_outcomes (
  outcome_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES dim_agents(agent_id),
  action_id         UUID NOT NULL REFERENCES dim_actions(action_id),
  context_id        UUID NOT NULL REFERENCES dim_contexts(context_id),
  customer_id       UUID NOT NULL REFERENCES dim_customers(customer_id),
  session_id        UUID NOT NULL,
  timestamp         TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  success           BOOLEAN NOT NULL,
  response_time_ms  INTEGER,
  error_code        VARCHAR(100),
  error_message     TEXT,
  raw_context       JSONB DEFAULT '{}',
  is_synthetic      BOOLEAN DEFAULT FALSE,    -- cold start prior injection flag
  is_deleted        BOOLEAN DEFAULT FALSE,    -- GDPR soft delete
  deleted_at        TIMESTAMPTZ,
  salience_score    FLOAT DEFAULT 1.0         -- importance weight for compression
);

-- ────────────────────────────────────────────
-- APPEND-ONLY ENFORCEMENT
-- BEFORE UPDATE trigger that raises a LOUD exception.
-- This replaces the silent CREATE RULE approach —
-- any accidental UPDATE will produce a clear error
-- message visible in logs and API responses.
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_outcome_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'fact_outcomes is APPEND-ONLY. Updates are not permitted. Use is_deleted=TRUE for soft deletes. Attempted update on outcome_id: %', OLD.outcome_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_append_only
BEFORE UPDATE ON fact_outcomes
FOR EACH ROW
EXECUTE FUNCTION prevent_outcome_update();
