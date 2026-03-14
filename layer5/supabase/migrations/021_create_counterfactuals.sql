-- ============================================================
-- LAYERINFINITE — Migration 021: Counterfactuals (fact_outcome_counterfactuals)
-- ============================================================
-- Stores IPS (Inverse Propensity Scoring) estimates for every
-- action that was NOT chosen at a decision point.
--
-- IPS formula:
--   counterfactual_est = real_outcome * (p_unchosen / p_chosen)
--   Clipped to [0.0, real_outcome] — conservative estimate
--
-- IPS weight (confidence):
--   ips_weight = p_unchosen * (1.0 - |counterfactual_est - real_outcome|)
--   Capped at 0.3 — counterfactuals are always lower confidence
--   than real observations.
--
-- RULES:
--   - Records are COMPLETELY IMMUTABLE once written
--   - No UPDATE or DELETE permitted (historical snapshots)
--   - One counterfactual estimate per (decision, unchosen action) pair
--   - All PKs are UUID, all timestamps are TIMESTAMPTZ
-- ============================================================

CREATE TABLE fact_outcome_counterfactuals (
  id                    UUID    PRIMARY KEY
                                DEFAULT gen_random_uuid(),

  -- The decision where this action was NOT chosen
  decision_id           UUID    NOT NULL
                                REFERENCES fact_decisions(id),

  -- The real outcome that actually occurred
  real_outcome_id       UUID    NOT NULL
                                REFERENCES fact_outcomes(outcome_id),

  -- The action that was NOT chosen
  unchosen_action_id    UUID    NOT NULL
                                REFERENCES dim_actions(action_id),
  unchosen_action_name  TEXT    NOT NULL,

  -- Propensity of the unchosen action at decision time
  -- (softmax probability from the ranked list)
  propensity_unchosen   FLOAT   NOT NULL
                                CHECK (
                                  propensity_unchosen > 0.0 AND
                                  propensity_unchosen <= 1.0
                                ),

  -- Propensity of the action that WAS chosen
  propensity_chosen     FLOAT   NOT NULL
                                CHECK (
                                  propensity_chosen > 0.0 AND
                                  propensity_chosen <= 1.0
                                ),

  -- The real outcome score from the chosen action
  real_outcome_score    FLOAT   NOT NULL
                                CHECK (
                                  real_outcome_score >= 0.0 AND
                                  real_outcome_score <= 1.0
                                ),

  -- IPS estimate: what the unchosen action might have scored.
  -- Formula: LEAST(real_outcome * (p_unchosen / p_chosen),
  --                real_outcome)
  counterfactual_est    FLOAT   NOT NULL
                                CHECK (
                                  counterfactual_est >= 0.0 AND
                                  counterfactual_est <= 1.0
                                ),

  -- Confidence in this estimate (0.0–0.3 range)
  -- Formula: LEAST(p_unchosen * (1.0 - ABS(est - real)), 0.3)
  ips_weight            FLOAT   NOT NULL
                                CHECK (
                                  ips_weight >= 0.0 AND
                                  ips_weight <= 0.3
                                ),

  -- Context at decision time for model training
  context_hash          TEXT    NOT NULL,

  -- Episode position (step number)
  episode_position      INT     NOT NULL DEFAULT 0,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Uniqueness: one counterfactual estimate per
  -- (decision, unchosen action) pair
  CONSTRAINT unique_decision_action
    UNIQUE (decision_id, unchosen_action_id)
);

-- ────────────────────────────────────────────
-- These records are COMPLETELY immutable once written.
-- They represent a historical estimate and must never change.
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_counterfactual_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'fact_outcome_counterfactuals records are immutable. '
    'IPS estimates are historical snapshots.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER counterfactuals_immutable
  BEFORE UPDATE ON fact_outcome_counterfactuals
  FOR EACH ROW
  EXECUTE FUNCTION prevent_counterfactual_update();

-- ────────────────────────────────────────────
-- No DELETE either — historical IPS estimates
-- are permanent audit records.
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_counterfactual_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'fact_outcome_counterfactuals records cannot be deleted. '
    'Historical IPS estimates are permanent audit records.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER counterfactuals_no_delete
  BEFORE DELETE ON fact_outcome_counterfactuals
  FOR EACH ROW
  EXECUTE FUNCTION prevent_counterfactual_delete();

COMMENT ON TABLE fact_outcome_counterfactuals IS
  'IPS estimates for unchosen actions at each decision point. '
  'Enables learning from actions that were not chosen — '
  'corrects the exploitation bias of only learning from '
  'the actions the policy selected.';
