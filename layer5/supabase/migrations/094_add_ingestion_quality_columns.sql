-- ══════════════════════════════════════════════════════════════
-- LAYERINFINITE — Migration 094: Ingestion Quality Layer
-- ══════════════════════════════════════════════════════════════
-- Adds four columns to fact_outcomes that implement the dual-pipeline
-- principle: raw developer truth is preserved, intelligence is layered
-- on top. The scoring engine can down-weight low-quality events without
-- ever mutating or discarding the original signal.
--
-- Columns added:
--   outcome_score_raw    — the exact value the developer sent (null if absent)
--   data_quality         — 0.0–1.0 completeness score, computed at ingestion
--   is_inconsistent      — TRUE when success=TRUE but outcome_score_raw < 0.3
--   mapping_confidence   — 0.0–1.0 confidence of issue_type → task_name mapping
--
-- Safety:
--   - Fully idempotent: all DDL uses IF NOT EXISTS / DO blocks.
--   - Backward compatible: all columns are nullable or defaulted.
--   - No destructive operations (no DROP, no RENAME, no UPDATE of existing rows).
--   - fact_outcomes APPEND-ONLY trigger is NOT affected.
-- ══════════════════════════════════════════════════════════════

-- 1. outcome_score_raw
--    The verbatim outcome_score the developer supplied.
--    NULL = developer did not provide a score (never fabricated).
--    Distinct from outcome_score, which may hold an inferred value.
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS outcome_score_raw DOUBLE PRECISION DEFAULT NULL;

-- 2. data_quality
--    Ingestion-time completeness score for this event (0.0–1.0).
--    Computed by computeDataQuality() in log-outcome.ts.
--    NULL = pre-migration row (treat as 1.0 in scoring engine for safety).
--    Factors: missing score (-0.25), missing session_id (-0.15),
--             inconsistent signal (-0.20), low mapping confidence (-0.20),
--             missing response_ms (-0.10), missing business_outcome (-0.10).
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS data_quality DOUBLE PRECISION DEFAULT NULL;

-- 3. is_inconsistent
--    TRUE when success=TRUE but outcome_score_raw < 0.3.
--    The developer says it succeeded but scored it poorly —
--    both facts are preserved, neither is overridden.
--    Scoring engine uses this to apply reduced trust to the success signal.
--    NULL = pre-migration row (unknown).
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS is_inconsistent BOOLEAN DEFAULT NULL;

-- 4. mapping_confidence
--    Confidence (0.0–1.0) that the issue_type → task_name mapping is correct.
--    1.0  = developer provided task_name directly (authoritative).
--    0.90 = exact match in known lookup table.
--    0.70 = prefix/pattern match in lookup table.
--    0.50 = slugified fallback (issue_type used as-is).
--    NULL = pre-migration row (unknown, treat as 1.0 for safety).
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS mapping_confidence DOUBLE PRECISION DEFAULT NULL;

-- ── Indexes ───────────────────────────────────────────────────
-- Allows scoring engine to efficiently filter / weight by quality tier.
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_data_quality
  ON fact_outcomes (data_quality)
  WHERE data_quality IS NOT NULL;

-- Allows fast lookup of inconsistent signals for dashboard alerting.
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_is_inconsistent
  ON fact_outcomes (is_inconsistent, customer_id)
  WHERE is_inconsistent = TRUE;

-- ── Verification ──────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'fact_outcomes'
  AND column_name IN (
    'outcome_score_raw',
    'data_quality',
    'is_inconsistent',
    'mapping_confidence'
  )
ORDER BY ordinal_position;

-- Expected:
-- outcome_score_raw  | double precision | NULL | YES
-- data_quality       | double precision | NULL | YES
-- is_inconsistent    | boolean          | NULL | YES
-- mapping_confidence | double precision | NULL | YES
