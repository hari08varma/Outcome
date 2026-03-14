-- Add 'sandbox' to the trust_status check constraint
ALTER TABLE agent_trust_scores
  DROP CONSTRAINT IF EXISTS agent_trust_scores_trust_status_check;

ALTER TABLE agent_trust_scores
  ADD CONSTRAINT agent_trust_scores_trust_status_check
  CHECK (trust_status IN ('trusted', 'probation', 'sandbox', 'suspended'));

-- Add human_review_required flag to policy responses
ALTER TABLE fact_decisions
  ADD COLUMN IF NOT EXISTS human_review_required BOOLEAN DEFAULT FALSE;
