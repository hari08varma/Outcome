-- ============================================================
-- LAYERINFINITE — Migration 022: World Model Artifacts
-- ============================================================
-- Stores trained world model artifacts for simulation.
-- The training service (Python/LightGBM) writes here.
-- The simulation engine reads from here.
--
-- Only one model per tier can be active at a time,
-- enforced by a partial unique index.
--
-- RULES:
--   - All PKs are UUID, all timestamps are TIMESTAMPTZ
--   - model_data is JSONB (serialized model parameters)
--   - activate_world_model() atomically swaps active models
-- ============================================================

CREATE TABLE world_model_artifacts (
  id                UUID        PRIMARY KEY
                                DEFAULT gen_random_uuid(),

  -- Model version (monotonically increasing integer)
  version           INT         NOT NULL UNIQUE,

  -- Which simulation tier this model serves
  -- 2 = LightGBM quantile regression (3 quantile models)
  -- 3 = MCTS value function (uses tier 2 internally)
  tier              INT         NOT NULL
                                CHECK (tier IN (2, 3)),

  -- Serialized model parameters as JSON.
  -- For tier 2 (LightGBM exported to JSON tree format):
  -- {
  --   "q50": { trees: [...] },    ← median prediction
  --   "q025": { trees: [...] },   ← lower 95% bound
  --   "q975": { trees: [...] },   ← upper 95% bound
  --   "feature_names": [...],
  --   "num_features": 12,
  --   "action_encoding": {"update_app": 0, ...},
  --   "context_encoding": {...}
  -- }
  model_data        JSONB       NOT NULL,

  -- Number of real episodes used in training
  training_episodes INT         NOT NULL
                                CHECK (training_episodes >= 0),

  -- Number of counterfactual estimates included in training
  counterfactual_episodes INT   NOT NULL DEFAULT 0,

  -- Validation metrics from training
  -- {
  --   "rmse": 0.12,
  --   "mae": 0.09,
  --   "r2": 0.73,
  --   "coverage_95": 0.94  ← how often true value is in interval
  -- }
  metrics           JSONB,

  -- Only one model per tier can be active at a time
  is_active         BOOL        NOT NULL DEFAULT FALSE,

  -- Min episodes required before this model should be used
  min_episodes_threshold INT    NOT NULL DEFAULT 200,

  -- Timestamps
  trained_at        TIMESTAMPTZ NOT NULL,
  activated_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────
-- Enforce only one active model per tier
-- ────────────────────────────────────────────
CREATE UNIQUE INDEX idx_world_model_one_active_per_tier
  ON world_model_artifacts (tier)
  WHERE is_active = TRUE;

-- ────────────────────────────────────────────
-- Function to activate a model (deactivates previous)
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION activate_world_model(
  p_model_id UUID
) RETURNS VOID AS $$
DECLARE
  v_tier INT;
BEGIN
  SELECT tier INTO v_tier
  FROM world_model_artifacts
  WHERE id = p_model_id;

  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'Model % not found', p_model_id;
  END IF;

  -- Deactivate current active model for this tier
  UPDATE world_model_artifacts
  SET is_active = FALSE, activated_at = NULL
  WHERE tier = v_tier AND is_active = TRUE;

  -- Activate the new model
  UPDATE world_model_artifacts
  SET is_active = TRUE, activated_at = NOW()
  WHERE id = p_model_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE world_model_artifacts IS
  'Stores trained ML model artifacts for simulation. '
  'Training service writes here weekly. '
  'Simulation engine reads the active model at startup.';
