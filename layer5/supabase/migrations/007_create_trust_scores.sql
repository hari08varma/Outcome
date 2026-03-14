-- ============================================================
-- LAYERINFINITE — Migration 007: Agent Trust Scores & Audit
-- ============================================================
-- Creates agent_trust_scores and agent_trust_audit tables.
-- Required by Phase 5 (Adaptive Policy Engine) for real trust
-- lookups instead of DEFAULT_TRUST fallback.
-- ============================================================

-- ────────────────────────────────────────────
-- TABLE: agent_trust_scores
-- One row per agent. Updated after every outcome.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_trust_scores (
    trust_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id              UUID NOT NULL UNIQUE REFERENCES dim_agents(agent_id) ON DELETE CASCADE,
    trust_score           FLOAT NOT NULL DEFAULT 0.7,
    total_decisions       INTEGER NOT NULL DEFAULT 0,
    correct_decisions     INTEGER NOT NULL DEFAULT 0,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    trust_status          VARCHAR(20) NOT NULL DEFAULT 'trusted'
                          CHECK (trust_status IN ('trusted', 'probation', 'suspended')),
    suspension_reason     TEXT,
    reinstated_by         VARCHAR(255),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────
-- TABLE: agent_trust_audit
-- Immutable audit log of trust changes.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_trust_audit (
    audit_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id              UUID NOT NULL REFERENCES dim_agents(agent_id) ON DELETE CASCADE,
    customer_id           UUID NOT NULL REFERENCES dim_customers(customer_id),
    event_type            VARCHAR(50) NOT NULL
                          CHECK (event_type IN ('suspended', 'reinstated', 'recalibrated', 'created', 'updated')),
    old_score             FLOAT,
    new_score             FLOAT,
    old_status            VARCHAR(20),
    new_status            VARCHAR(20),
    performed_by          TEXT,
    reason                TEXT,
    performed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────
-- INDEXES
-- ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trust_scores_agent ON agent_trust_scores(agent_id);
CREATE INDEX IF NOT EXISTS idx_trust_scores_status ON agent_trust_scores(trust_status);
CREATE INDEX IF NOT EXISTS idx_trust_audit_agent ON agent_trust_audit(agent_id);
CREATE INDEX IF NOT EXISTS idx_trust_audit_customer ON agent_trust_audit(customer_id);
CREATE INDEX IF NOT EXISTS idx_trust_audit_event_type ON agent_trust_audit(event_type);
CREATE INDEX IF NOT EXISTS idx_trust_audit_performed_at ON agent_trust_audit(performed_at DESC);

-- ────────────────────────────────────────────
-- RLS POLICIES
-- ────────────────────────────────────────────
ALTER TABLE agent_trust_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_trust_audit ENABLE ROW LEVEL SECURITY;

-- Service role (API server) can do everything
CREATE POLICY "service_role_trust_scores"
    ON agent_trust_scores
    FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE POLICY "service_role_trust_audit"
    ON agent_trust_audit
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- ────────────────────────────────────────────
-- FUNCTION: Auto-initialize trust on new agent
-- Creates a trust_scores row when a new agent is inserted
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_init_agent_trust()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO agent_trust_scores (agent_id)
    VALUES (NEW.agent_id)
    ON CONFLICT (agent_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_init_agent_trust
    AFTER INSERT ON dim_agents
    FOR EACH ROW
    EXECUTE FUNCTION fn_init_agent_trust();

-- ────────────────────────────────────────────
-- Seed trust rows for any existing agents
-- ────────────────────────────────────────────
INSERT INTO agent_trust_scores (agent_id)
SELECT agent_id FROM dim_agents
ON CONFLICT (agent_id) DO NOTHING;
