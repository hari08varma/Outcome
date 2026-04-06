-- ══════════════════════════════════════════════════════════════
-- LAYERINFINITE — Migration 096: Cross-Event Validation + Semantic Clustering + Inconsistency Taxonomy
-- ══════════════════════════════════════════════════════════════
-- Additive migration only. No destructive changes.
-- Extends fact_outcomes with:
--   - semantic action clustering metadata
--   - richer inconsistency taxonomy (type + reason)
--   - cross-event lifecycle fields for delayed truth validation
--   - retry-chain metadata for cross-event lineage
--
-- Safe to rerun: uses IF NOT EXISTS / guarded constraints.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ── Semantic clustering metadata ─────────────────────────────
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS semantic_cluster_key VARCHAR(120) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS semantic_cluster_domain VARCHAR(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS semantic_cluster_intent VARCHAR(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS semantic_cluster_confidence DOUBLE PRECISION DEFAULT NULL;

-- ── Inconsistency taxonomy extension ────────────────────────
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS inconsistency_type VARCHAR(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS inconsistency_reason TEXT DEFAULT NULL;

-- ── Cross-event lifecycle + retry-chain metadata ────────────
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS cross_event_status VARCHAR(40) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS cross_event_last_updated TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS retry_chain_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS retry_attempt INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cross_event_attempt_count INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS canonical_outcome_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pending_registration_id UUID DEFAULT NULL;

-- Backfill null status for pre-migration rows to keep query logic simple.
UPDATE fact_outcomes
SET cross_event_status = 'none'
WHERE cross_event_status IS NULL;

-- ── Constraints (guarded) ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'chk_fact_outcomes_cross_event_status'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_cross_event_status
      CHECK (
        cross_event_status IN (
          'none',
          'pending_signal',
          'confirmed',
          'conflict',
          'resolved'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'chk_fact_outcomes_retry_attempt_non_negative'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_retry_attempt_non_negative
      CHECK (retry_attempt IS NULL OR retry_attempt >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'chk_fact_outcomes_cross_event_attempt_count_positive'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT chk_fact_outcomes_cross_event_attempt_count_positive
      CHECK (
        cross_event_attempt_count IS NULL
        OR cross_event_attempt_count >= 1
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'fk_fact_outcomes_canonical_outcome_id'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT fk_fact_outcomes_canonical_outcome_id
      FOREIGN KEY (canonical_outcome_id)
      REFERENCES fact_outcomes(outcome_id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'fact_outcomes'
      AND constraint_name = 'fk_fact_outcomes_pending_registration_id'
  ) THEN
    ALTER TABLE fact_outcomes
      ADD CONSTRAINT fk_fact_outcomes_pending_registration_id
      FOREIGN KEY (pending_registration_id)
      REFERENCES dim_pending_signal_registrations(registration_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_semantic_cluster_key
  ON fact_outcomes (customer_id, semantic_cluster_key)
  WHERE semantic_cluster_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_cross_event_status
  ON fact_outcomes (customer_id, cross_event_status)
  WHERE cross_event_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_retry_chain
  ON fact_outcomes (customer_id, retry_chain_id, retry_attempt)
  WHERE retry_chain_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_pending_registration_id
  ON fact_outcomes (pending_registration_id)
  WHERE pending_registration_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fact_outcomes_inconsistency_type
  ON fact_outcomes (customer_id, inconsistency_type)
  WHERE inconsistency_type IS NOT NULL;

COMMIT;

-- ── Verification ────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'fact_outcomes'
  AND column_name IN (
    'semantic_cluster_key',
    'semantic_cluster_domain',
    'semantic_cluster_intent',
    'semantic_cluster_confidence',
    'inconsistency_type',
    'inconsistency_reason',
    'cross_event_status',
    'cross_event_last_updated',
    'retry_chain_id',
    'retry_attempt',
    'cross_event_attempt_count',
    'canonical_outcome_id',
    'pending_registration_id'
  )
ORDER BY ordinal_position;
