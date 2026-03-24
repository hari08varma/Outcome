-- ══════════════════════════════════════════════════════════════
-- Migration 067: Add signal infrastructure columns to fact_outcomes
-- Part of: Real Outcome Signal Integration Phase 1
-- All existing rows retain their existing data unchanged.
-- Safe to run multiple times — uses IF NOT EXISTS on all DDL.
-- ══════════════════════════════════════════════════════════════

-- signal_source: who or what produced the outcome signal
-- 'explicit'        = developer passed success/score directly (existing behaviour)
-- 'causal_graph'    = Phase 2 TracedResponse derived it automatically
-- 'http_inference'  = Phase 3 interceptor inferred from HTTP status code
-- 'signal_contract' = Phase 4 Signal Contract evaluated it
ALTER TABLE fact_outcomes
ADD COLUMN IF NOT EXISTS signal_source VARCHAR(50) DEFAULT 'explicit';

-- signal_confidence: 0.0–1.0 trust in this signal
-- NULL  = not tracked (all existing rows remain NULL until Phase 2 runs)
-- 0.90  = causal depth 0 (direct field access — maximum confidence)
-- 0.58  = causal depth 8 (deepest trusted chain before tag retirement)
-- 0.50  = HTTP status inference
-- 0.30  = LLM evaluation fallback
ALTER TABLE fact_outcomes
ADD COLUMN IF NOT EXISTS signal_confidence FLOAT DEFAULT NULL;

-- causal_depth: how many transformation layers the traced value passed through
-- NULL = not tracked (all existing rows)
-- 0    = direct field access: response.status === 'succeeded'
-- 4    = four transformations: statusMap[raw.toLowerCase()].mapped
-- 9+   = tag retired, falls back to HTTP inference
ALTER TABLE fact_outcomes
ADD COLUMN IF NOT EXISTS causal_depth INT DEFAULT NULL;

-- signal_pending: TRUE when outcome is waiting for a better real-world signal.
-- FALSE (default) = outcome is final, no pending update expected.
-- TRUE  = Phase 4 async completion tracking registered a listener.
ALTER TABLE fact_outcomes
ADD COLUMN IF NOT EXISTS signal_pending BOOLEAN DEFAULT FALSE;

-- signal_updated_at: when was this outcome's signal last upgraded?
-- NULL = signal has never been updated since initial log.
-- Non-null = a better signal arrived and retroactively corrected this outcome.
ALTER TABLE fact_outcomes
ADD COLUMN IF NOT EXISTS signal_updated_at TIMESTAMPTZ DEFAULT NULL;

-- ── Index for the pending signal query (Phase 5 pipeline) ──────
-- The process-pending-outcomes job will query:
--   WHERE signal_pending = TRUE AND timestamp < NOW() - INTERVAL '6 hours'
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_signal_pending
ON fact_outcomes (signal_pending, timestamp)
WHERE signal_pending = TRUE;

-- ── Verification ───────────────────────────────────────────────
SELECT
    column_name,
    data_type,
    column_default,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'fact_outcomes'
  AND column_name IN (
      'signal_source',
      'signal_confidence',
      'causal_depth',
      'signal_pending',
      'signal_updated_at'
  )
ORDER BY ordinal_position;

-- Expected:
-- signal_source      | character varying | 'explicit'::character varying | YES
-- signal_confidence  | double precision  | NULL                          | YES
-- causal_depth       | integer           | NULL                          | YES
-- signal_pending     | boolean           | false                         | YES
-- signal_updated_at  | timestamp with..  | NULL                          | YES
