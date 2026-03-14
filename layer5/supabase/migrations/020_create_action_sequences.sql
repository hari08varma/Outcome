-- ============================================================
-- LAYERINFINITE — Migration 020: Action Sequences (action_sequences)
-- ============================================================
-- Tracks ordered action sequences within episodes.
-- Enables learning that specific multi-step paths have
-- different resolution rates than single actions.
--
-- Example: clear_cache → update_app resolves 89% of the time
-- whereas update_app alone resolves 71% of the time.
--
-- RULES:
--   - action_sequence is APPEND-ONLY (can grow, not shrink or mutate)
--   - Closed sequences must have a final_outcome
--   - All PKs are UUID, all timestamps are TIMESTAMPTZ
-- ============================================================

-- ────────────────────────────────────────────
-- Helper: update_updated_at_column()
-- This function does not exist in prior migrations.
-- Created here for use by action_sequences and any
-- future tables that need auto-updated timestamps.
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────
-- TABLE: action_sequences
-- ────────────────────────────────────────────
CREATE TABLE action_sequences (
  id               UUID        PRIMARY KEY
                               DEFAULT gen_random_uuid(),

  episode_id       UUID        NOT NULL
                               REFERENCES fact_episodes(episode_id),
  agent_id         UUID        NOT NULL
                               REFERENCES dim_agents(agent_id),

  -- Stable context hash for grouping
  context_hash     TEXT        NOT NULL,

  -- Ordered list of action names in this episode.
  -- Example: ARRAY['update_app', 'clear_cache', 'restart_service']
  -- Updated append-only as episode progresses.
  action_sequence  TEXT[]      NOT NULL,

  -- Computed automatically from action_sequence length
  sequence_length  INT         NOT NULL
                               GENERATED ALWAYS AS
                               (array_length(action_sequence, 1))
                               STORED,

  -- Final outcome — NULL until episode is closed.
  -- Set to the last outcome_score in the episode,
  -- or the average if multiple outcomes exist.
  final_outcome    FLOAT       CHECK (
                                 final_outcome IS NULL OR
                                 (final_outcome >= 0.0 AND
                                  final_outcome <= 1.0)
                               ),

  -- Whether this sequence achieved resolution
  -- (final_outcome >= 0.7, configurable via env var)
  resolved         BOOL,

  -- Total wall-clock time for the sequence (sum of response_ms)
  total_response_ms INT        CHECK (
                                 total_response_ms IS NULL OR
                                 total_response_ms >= 0
                               ),

  -- Timestamps
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Null until episode closes
  closed_at        TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT sequence_not_empty
    CHECK (array_length(action_sequence, 1) >= 1),
  CONSTRAINT closed_has_outcome
    CHECK (
      closed_at IS NULL OR
      final_outcome IS NOT NULL
    )
);

-- ────────────────────────────────────────────
-- Auto-update updated_at on every UPDATE
-- ────────────────────────────────────────────
CREATE TRIGGER action_sequences_updated_at
  BEFORE UPDATE ON action_sequences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────
-- Prevent append-only violation on action_sequence:
-- New actions can be added (array grows) but existing
-- entries cannot change order or content.
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_sequence_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow growing the array (appending new actions)
  IF array_length(NEW.action_sequence, 1) <
     array_length(OLD.action_sequence, 1) THEN
    RAISE EXCEPTION
      'action_sequences.action_sequence cannot shrink. '
      'Sequences are append-only.';
  END IF;

  -- Existing elements must not change
  FOR i IN 1..array_length(OLD.action_sequence, 1) LOOP
    IF NEW.action_sequence[i] != OLD.action_sequence[i] THEN
      RAISE EXCEPTION
        'action_sequences.action_sequence[%] cannot change '
        'from % to %. Sequences are append-only.',
        i, OLD.action_sequence[i], NEW.action_sequence[i];
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER action_sequences_append_only
  BEFORE UPDATE ON action_sequences
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sequence_mutation();

COMMENT ON TABLE action_sequences IS
  'Tracks ordered multi-step action sequences within episodes. '
  'Records what sequence of actions an agent took to resolve '
  '(or fail to resolve) a situation. Enables sequence-level '
  'learning: which paths lead to resolution most reliably.';
