-- ============================================================
-- LAYER5 — Migration 019: Decision Tracking (fact_decisions)
-- ============================================================
-- Records the complete ranked list and propensities at every
-- get-scores call. This is what makes counterfactual learning
-- possible — stores the full ranked list so we can estimate
-- what unchosen actions would have produced.
--
-- A "propensity" is the probability that the policy would
-- choose a given action, computed as softmax of action scores:
--   P(action_i) = exp(score_i / τ) / Σ exp(score_j / τ)
--   where τ = 1.0 (temperature, tunable later)
--
-- RULES:
--   - ranked_actions is IMMUTABLE after creation
--   - Only chosen_action_name, chosen_action_id, outcome_id,
--     resolved_at may be updated (filled in after log_outcome)
--   - All PKs are UUID, all timestamps are TIMESTAMPTZ
-- ============================================================

CREATE TABLE fact_decisions (
  id               UUID        PRIMARY KEY
                               DEFAULT gen_random_uuid(),

  -- Which agent made this decision
  agent_id         UUID        NOT NULL
                               REFERENCES dim_agents(agent_id),

  -- Context at decision time (FK to existing dim_contexts)
  context_id       UUID        REFERENCES dim_contexts(context_id),

  -- Stable hash of context for grouping similar decisions
  context_hash     TEXT        NOT NULL,

  -- Complete ranked list at decision time, including
  -- score and propensity for every ranked action.
  -- Structure: [{
  --   "action_name": "update_app",
  --   "action_id":   "uuid",
  --   "score":       0.85,
  --   "rank":        1,
  --   "propensity":  0.68   ← softmax probability
  -- }, ...]
  ranked_actions   JSONB       NOT NULL,

  -- Number of actions ranked (for quick filtering)
  ranked_count     INT         NOT NULL
                               GENERATED ALWAYS AS
                               (jsonb_array_length(ranked_actions))
                               STORED,

  -- Which episode this decision belongs to (nullable —
  -- not all decisions are part of a tracked episode)
  episode_id       UUID        REFERENCES fact_episodes(episode_id),

  -- Step position within the episode (0-based)
  -- 0 = first action in episode
  -- 1 = second action (something was already tried)
  episode_position INT         NOT NULL DEFAULT 0
                               CHECK (episode_position >= 0),

  -- What action was actually chosen
  -- Populated when log_outcome is called with this decision_id
  chosen_action_name TEXT,
  chosen_action_id   UUID      REFERENCES dim_actions(action_id),

  -- Outcome reference — populated after log_outcome
  outcome_id       UUID        REFERENCES fact_outcomes(outcome_id),

  -- Timestamps
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,  -- populated when outcome logged

  -- Constraints
  CONSTRAINT valid_ranked_actions
    CHECK (jsonb_array_length(ranked_actions) > 0),
  CONSTRAINT valid_ranked_count
    CHECK (ranked_count > 0)
);

-- ────────────────────────────────────────────
-- Immutability: ranked_actions must never change
-- after creation (decision was made at that point)
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_ranked_actions_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ranked_actions IS DISTINCT FROM OLD.ranked_actions THEN
    RAISE EXCEPTION
      'fact_decisions.ranked_actions is immutable. '
      'The decision was made — it cannot be revised.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fact_decisions_immutable_ranked
  BEFORE UPDATE ON fact_decisions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ranked_actions_update();

-- Allow updating only: chosen_action_name, chosen_action_id,
-- outcome_id, resolved_at (these are filled in later)
-- Everything else is locked by the trigger above.

COMMENT ON TABLE fact_decisions IS
  'Records complete decision context at every get-scores call. '
  'Prerequisite for counterfactual learning — stores the '
  'full ranked list and propensities so we can estimate '
  'what unchosen actions would have produced.';
