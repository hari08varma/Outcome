-- ══════════════════════════════════════════════════════════════
-- LAYERINFINITE — Migration 095: Score Origin, Mapping Tier, Inconsistency Rule Version
-- ══════════════════════════════════════════════════════════════
-- Adds three columns to fact_outcomes to complete the ingestion
-- quality audit trail started in migration 094.
--
-- Columns added:
--   score_origin             — 'provided' or 'inferred': was outcome_score sent by developer?
--   mapping_tier             — exact confidence tier from issue_type → task_name resolution
--   inconsistency_rule_version — which threshold rule flagged is_inconsistent (e.g. 'v1:threshold=0.3')
--
-- Safety:
--   - Fully idempotent: all DDL uses IF NOT EXISTS / DO blocks.
--   - Backward compatible: all columns are nullable or defaulted.
--   - No destructive operations (no DROP, no RENAME, no UPDATE of existing rows).
--   - fact_outcomes APPEND-ONLY trigger is NOT affected.
-- ══════════════════════════════════════════════════════════════

-- 1. score_origin
--    'provided' = developer explicitly sent outcome_score (score_fn was used).
--    'inferred'  = outcome_score was absent; scoring engine fell back to binary success.
--    NULL = pre-migration row (unknown provenance).
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS score_origin VARCHAR(10) DEFAULT NULL;

-- 2. mapping_tier
--    Exact tier string from TaskInferResult.tier in task-infer.ts.
--    Values: 'developer_provided' | 'exact_match' | 'prefix_match' |
--            'slugified_fallback' | 'unknown'
--    NULL = pre-migration row.
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS mapping_tier VARCHAR(30) DEFAULT NULL;

-- 3. inconsistency_rule_version
--    Encodes which rule and threshold produced is_inconsistent=TRUE.
--    Format: 'v1:threshold=<N>' where N = the configured threshold value.
--    Example: 'v1:threshold=0.3'
--    NULL = pre-migration row OR is_inconsistent=FALSE (not flagged).
ALTER TABLE fact_outcomes
  ADD COLUMN IF NOT EXISTS inconsistency_rule_version VARCHAR(30) DEFAULT NULL;

-- ── Indexes ───────────────────────────────────────────────────
-- Allows dashboard to efficiently filter by score origin tier.
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_score_origin
  ON fact_outcomes (score_origin, customer_id)
  WHERE score_origin IS NOT NULL;

-- Allows analytics to group by mapping quality tier.
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_mapping_tier
  ON fact_outcomes (mapping_tier, customer_id)
  WHERE mapping_tier IS NOT NULL;

-- ── Verification ──────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  character_maximum_length,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'fact_outcomes'
  AND column_name IN (
    'score_origin',
    'mapping_tier',
    'inconsistency_rule_version'
  )
ORDER BY ordinal_position;

-- Expected:
-- score_origin              | character varying | 10 | NULL | YES
-- mapping_tier              | character varying | 30 | NULL | YES
-- inconsistency_rule_version| character varying | 30 | NULL | YES
