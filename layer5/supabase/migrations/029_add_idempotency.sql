-- ============================================================
-- LAYER5 — Migration 029: Idempotency Tracking
-- ============================================================
-- Adds idempotency tracking for fact_outcomes to prevent
-- duplicates during client network retries.
-- ============================================================

CREATE TABLE fact_outcome_idempotency (
  idempotency_key  TEXT        NOT NULL,
  outcome_id       UUID        NOT NULL REFERENCES fact_outcomes(outcome_id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  PRIMARY KEY (idempotency_key)
);

-- Auto-expire idempotency records after 24 hours.
-- Use pg_cron if available:
SELECT cron.schedule(
  'cleanup-idempotency-keys',
  '0 4 * * *',  -- 4 AM daily
  $$
    DELETE FROM fact_outcome_idempotency
    WHERE created_at < NOW() - INTERVAL '24 hours';
  $$
);

-- RLS: customers see only their own idempotency keys
ALTER TABLE fact_outcome_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_select ON fact_outcome_idempotency
  FOR SELECT
  USING (
    outcome_id IN (
      SELECT outcome_id FROM fact_outcomes
      WHERE agent_id IN (
        SELECT agent_id FROM dim_agents
        WHERE customer_id = auth.uid()::uuid
      )
    )
  );

CREATE POLICY idempotency_insert ON fact_outcome_idempotency
  FOR INSERT
  WITH CHECK (
    outcome_id IN (
      SELECT outcome_id FROM fact_outcomes
      WHERE agent_id IN (
        SELECT agent_id FROM dim_agents
        WHERE customer_id = auth.uid()::uuid
      )
    )
  );
