-- Add customer_id to action_sequences for proper tenant isolation.
-- Backfills from dim_agents join. Adds NOT NULL after backfill.
-- Updates mv_sequence_scores to include customer_id in GROUP BY.

BEGIN;

-- 1. Add nullable column
ALTER TABLE action_sequences
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES dim_customers(customer_id);

-- 2. Backfill from dim_agents
UPDATE action_sequences AS seq
SET customer_id = a.customer_id
FROM dim_agents AS a
WHERE seq.agent_id = a.agent_id
  AND seq.customer_id IS NULL;

-- Guardrail: fail early with a clear error if orphaned action_sequences rows
-- still have NULL customer_id after backfill (e.g., missing dim_agents rows).
DO $$
DECLARE
  null_customer_id_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO null_customer_id_count
  FROM action_sequences
  WHERE customer_id IS NULL;

  IF null_customer_id_count > 0 THEN
    RAISE EXCEPTION
      'Migration 079 aborted: % action_sequences rows still have NULL customer_id after backfill. Delete or reassign orphaned action_sequences rows before re-running this migration.',
      null_customer_id_count;
  END IF;
END
$$;

-- 3. Add NOT NULL constraint after backfill
ALTER TABLE action_sequences
  ALTER COLUMN customer_id SET NOT NULL;

-- 4. Add index for the new query pattern
CREATE INDEX IF NOT EXISTS idx_action_sequences_customer_context
  ON action_sequences(customer_id, context_hash);

-- 5. Refresh mv_sequence_scores to include customer_id
-- (DROP and recreate — adjust SELECT/GROUP BY to include customer_id)
DROP MATERIALIZED VIEW IF EXISTS mv_sequence_scores;

CREATE MATERIALIZED VIEW mv_sequence_scores AS
SELECT
  customer_id,
  agent_id,
  context_hash,
  action_sequence,
  COUNT(*)                                          AS observations,
  AVG(final_outcome)                                AS mean_outcome,
  AVG(final_outcome::float)
    - 1.96 * STDDEV(final_outcome::float)
      / NULLIF(SQRT(COUNT(*)), 0)                   AS outcome_lower_ci,
  AVG(final_outcome::float)
    + 1.96 * STDDEV(final_outcome::float)
      / NULLIF(SQRT(COUNT(*)), 0)                   AS outcome_upper_ci,
  (AVG(final_outcome::float)
    + 1.96 * STDDEV(final_outcome::float)
      / NULLIF(SQRT(COUNT(*)), 0))
  - (AVG(final_outcome::float)
    - 1.96 * STDDEV(final_outcome::float)
      / NULLIF(SQRT(COUNT(*)), 0))                  AS outcome_interval_width,
  AVG(CASE WHEN final_outcome >= 0.7 THEN 1.0 ELSE 0.0 END)
                                                    AS resolution_rate,
  -- Wilson score lower bound for resolution_rate
  (AVG(CASE WHEN final_outcome >= 0.7 THEN 1.0 ELSE 0.0 END)
    + 1.96*1.96 / (2 * NULLIF(COUNT(*), 0))
    - 1.96 * SQRT(
        (AVG(CASE WHEN final_outcome >= 0.7 THEN 1.0 ELSE 0.0 END)
          * (1 - AVG(CASE WHEN final_outcome >= 0.7 THEN 1.0 ELSE 0.0 END))
          + 1.96*1.96 / (4 * NULLIF(COUNT(*), 0)))
        / NULLIF(COUNT(*), 0)))
  / (1 + 1.96*1.96 / NULLIF(COUNT(*), 0))          AS resolution_rate_lower,
  AVG(array_length(action_sequence, 1))             AS avg_steps
FROM action_sequences
WHERE final_outcome IS NOT NULL
GROUP BY customer_id, agent_id, context_hash, action_sequence;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sequence_scores_pk
  ON mv_sequence_scores(customer_id, agent_id, context_hash, action_sequence);

COMMIT;
