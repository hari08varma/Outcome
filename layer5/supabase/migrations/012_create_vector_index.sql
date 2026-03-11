-- ══════════════════════════════════════════════════════════════
-- Migration 012: Create pgvector IVFFlat index on dim_contexts
-- ══════════════════════════════════════════════════════════════
-- Requires: pgvector extension (enabled in migration 001)
-- Purpose:  Accelerate cosine similarity search for context
--           embedding matching in GET /v1/get-scores
--
-- lists = 10 is appropriate for < 1,000 rows.
-- When dim_contexts exceeds 10,000 rows, rebuild:
--   REINDEX INDEX CONCURRENTLY idx_contexts_vector;
-- and increase lists to sqrt(row_count) rounded up.
-- ══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_contexts_vector
ON dim_contexts
USING ivfflat (context_vector vector_cosine_ops)
WITH (lists = 10);

COMMENT ON INDEX idx_contexts_vector IS
'IVFFlat index for cosine similarity search on context embeddings. Rebuild when row count exceeds 10,000: REINDEX INDEX CONCURRENTLY idx_contexts_vector;';
