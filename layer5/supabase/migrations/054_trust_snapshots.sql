-- ============================================================
-- LAYERINFINITE — Migration 054: Trust Score Snapshots
-- Supports coordinated failure interlock: snapshot trust before
-- decay so it can be restored when infrastructure incidents resolve.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_trust_snapshots (
  id                   BIGSERIAL    PRIMARY KEY,
  agent_id             UUID         NOT NULL REFERENCES dim_agents(agent_id) ON DELETE CASCADE,
  trust_score          FLOAT        NOT NULL,
  trust_status         TEXT         NOT NULL,
  consecutive_failures INT          NOT NULL DEFAULT 0,
  snapshot_reason      TEXT         NOT NULL, -- 'pre_failure' | 'pre_incident' | 'manual'
  incident_id          TEXT,                  -- populated when snapshotted due to coordinated incident
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Fast lookup: most recent snapshot for an agent before a given timestamp
CREATE INDEX IF NOT EXISTS idx_trust_snapshots_agent_time
  ON agent_trust_snapshots(agent_id, created_at DESC);

-- Filter by incident for bulk restore
CREATE INDEX IF NOT EXISTS idx_trust_snapshots_incident
  ON agent_trust_snapshots(incident_id)
  WHERE incident_id IS NOT NULL;

-- RLS: snapshots are internal — no direct customer access
ALTER TABLE agent_trust_snapshots ENABLE ROW LEVEL SECURITY;

-- Retention cleanup function (called daily, migration 055)
CREATE OR REPLACE FUNCTION cleanup_trust_snapshots()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM agent_trust_snapshots
    WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$;
