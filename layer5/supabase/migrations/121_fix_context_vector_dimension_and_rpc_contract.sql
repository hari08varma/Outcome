-- ============================================================================
-- Migration 121: Fix context vector dimensional contract and index health
--
-- Root cause fixed:
--   dim_contexts.context_vector was created as vector(1536) while
--   match_context_vector() expects vector(384), causing runtime mismatch.
--
-- This migration standardizes context vectors to 384 dimensions, preserves
-- compatible vectors, nulls incompatible legacy vectors, rebuilds the index,
-- and reasserts the RPC signature.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- Rebuild vector index after dimensional type change.
DROP INDEX IF EXISTS idx_contexts_vector;

ALTER TABLE dim_contexts
  ALTER COLUMN context_vector TYPE extensions.vector(384)
  USING (
    CASE
      WHEN context_vector IS NULL THEN NULL
      WHEN COALESCE(
        array_length(string_to_array(trim(both '[]' from context_vector::text), ','), 1),
        0
      ) = 384 THEN context_vector::extensions.vector(384)
      ELSE NULL
    END
  );

COMMENT ON COLUMN dim_contexts.context_vector IS
  'Context embedding vector (384-dim). Incompatible legacy dimensions are nulled during migration 121.';

CREATE INDEX IF NOT EXISTS idx_contexts_vector
  ON dim_contexts
  USING ivfflat (context_vector extensions.vector_cosine_ops)
  WITH (lists = 100);

-- Ensure RPC contract remains aligned with the column dimensionality.
CREATE OR REPLACE FUNCTION match_context_vector(
  query_vector    extensions.vector(384),
  p_customer_id   text,
  p_model         text,
  p_threshold     float DEFAULT 0.6,
  p_limit         int   DEFAULT 1,
  p_schema_version int  DEFAULT 2
)
RETURNS TABLE (
  context_id  text,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    context_id,
    1 - (context_vector OPERATOR(extensions.<=>) query_vector) AS similarity
  FROM dim_contexts
  WHERE customer_id    = p_customer_id::uuid
    AND context_vector IS NOT NULL
    AND embedding_model = p_model
    AND embedding_schema_version = p_schema_version
    AND 1 - (context_vector OPERATOR(extensions.<=>) query_vector) > p_threshold
  ORDER BY context_vector OPERATOR(extensions.<=>) query_vector
  LIMIT p_limit;
$$;

COMMIT;
