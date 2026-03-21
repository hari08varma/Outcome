ALTER TABLE agent_trust_scores
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill existing rows
UPDATE agent_trust_scores
SET updated_at = NOW()
WHERE updated_at IS NULL;
