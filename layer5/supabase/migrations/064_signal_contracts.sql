-- Migration 064: Signal contracts + pending signal registrations

CREATE TABLE IF NOT EXISTS dim_signal_contracts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES dim_customers(id),
  action_name       TEXT NOT NULL,
  success_condition TEXT NOT NULL,
  score_expression  TEXT NOT NULL,
  timeout_hours     INT NOT NULL DEFAULT 24,
  fallback_strategy TEXT NOT NULL DEFAULT 'use_http_status'
                    CHECK (fallback_strategy IN ('use_http_status','explicit_only','always_pending')),
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_contract UNIQUE (customer_id, action_name)
);

CREATE TABLE IF NOT EXISTS dim_pending_signal_registrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome_id        UUID NOT NULL REFERENCES fact_outcomes(id),
  customer_id       UUID NOT NULL REFERENCES dim_customers(id),
  action_name       TEXT NOT NULL,
  provider_hint     TEXT,
  contract_id       UUID REFERENCES dim_signal_contracts(id),
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  final_score       FLOAT,
  is_resolved       BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_pending_outcome_id
  ON dim_pending_signal_registrations(outcome_id);

CREATE INDEX IF NOT EXISTS idx_pending_customer_unres
  ON dim_pending_signal_registrations(customer_id)
  WHERE is_resolved = false;

CREATE INDEX IF NOT EXISTS idx_contracts_customer
  ON dim_signal_contracts(customer_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_contracts_action
  ON dim_signal_contracts(customer_id, action_name)
  WHERE is_active = true;

ALTER TABLE dim_signal_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dim_pending_signal_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY signal_contracts_select ON dim_signal_contracts
  FOR SELECT
  USING (
    customer_id IN (
      SELECT customer_id
      FROM dim_agents
      WHERE api_key_hash IS NOT NULL
    )
  );

CREATE POLICY signal_contracts_insert ON dim_signal_contracts
  FOR INSERT
  WITH CHECK (
    customer_id IN (
      SELECT customer_id
      FROM dim_agents
      WHERE api_key_hash IS NOT NULL
    )
  );

CREATE POLICY pending_signal_select ON dim_pending_signal_registrations
  FOR SELECT
  USING (
    customer_id IN (
      SELECT customer_id
      FROM dim_agents
      WHERE api_key_hash IS NOT NULL
    )
  );

CREATE POLICY pending_signal_insert_service_role ON dim_pending_signal_registrations
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
