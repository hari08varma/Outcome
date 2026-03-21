-- ============================================================
-- LAYERINFINITE — Migration 056: Embedding Versioning
-- Adds version metadata and source text storage to dim_contexts.
-- Creates reference corpus and drift report tables.
-- ============================================================

-- Add versioning columns to dim_contexts
ALTER TABLE dim_contexts
  ADD COLUMN IF NOT EXISTS source_text             TEXT,
  ADD COLUMN IF NOT EXISTS source_text_hash        TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model         TEXT  DEFAULT 'gte-small',
  ADD COLUMN IF NOT EXISTS embedding_version       TEXT  DEFAULT '2024-01-01',
  ADD COLUMN IF NOT EXISTS embedding_dimension     INT   DEFAULT 1536,
  ADD COLUMN IF NOT EXISTS embedding_schema_version INT  DEFAULT 1;

-- Backfill model info for all existing rows
UPDATE dim_contexts
  SET embedding_model          = COALESCE(embedding_model, 'gte-small'),
      embedding_version        = COALESCE(embedding_version, '2024-01-01'),
    embedding_dimension      = COALESCE(embedding_dimension, 1536),
    embedding_schema_version = COALESCE(embedding_schema_version, 1)
  WHERE embedding_model IS NULL
   OR embedding_version IS NULL
   OR embedding_dimension IS NULL
   OR embedding_schema_version IS NULL;

-- Index for filtering by model version (compatibility checks)
CREATE INDEX IF NOT EXISTS idx_contexts_embedding_model
  ON dim_contexts(embedding_model, embedding_version);

-- ── Reference corpus for drift detection ──────────────────────
CREATE TABLE IF NOT EXISTS embedding_reference_corpus (
  id               BIGSERIAL    PRIMARY KEY,
  sample_text      TEXT         NOT NULL,
  reference_vector VECTOR       NOT NULL,
  embedding_model  TEXT         NOT NULL,
  embedding_version TEXT        NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ref_corpus_model
  ON embedding_reference_corpus(embedding_model, embedding_version);

-- ── Drift detection audit log ──────────────────────────────────
CREATE TABLE IF NOT EXISTS embedding_drift_reports (
  id              BIGSERIAL    PRIMARY KEY,
  mean_similarity FLOAT        NOT NULL,
  min_similarity  FLOAT        NOT NULL,
  sample_size     INT          NOT NULL,
  drift_detected  BOOLEAN      NOT NULL,
  drift_threshold FLOAT        NOT NULL DEFAULT 0.995,
  embedding_model TEXT         NOT NULL,
  checked_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Retention: keep 90 days of drift reports
CREATE OR REPLACE FUNCTION cleanup_drift_reports()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM embedding_drift_reports
    WHERE checked_at < NOW() - INTERVAL '90 days';
END;
$$;
