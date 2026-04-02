-- match_context_vector: customer-scoped nearest-neighbour context lookup.
-- Uses pgvector <=> cosine distance operator.
-- Requires an ivfflat or hnsw index on dim_contexts(context_vector)
-- for O(log n) performance at scale:
--   CREATE INDEX ON dim_contexts USING hnsw (context_vector vector_cosine_ops);
-- Without the index, this is a full table scan (acceptable up to ~50k rows).
-- WARNING: embedding_schema_version is hardcoded to 2.
-- Update this value or parameterize when CURRENT_EMBEDDING_SCHEMA_VERSION
-- increments in context-embed.ts.

CREATE OR REPLACE FUNCTION match_context_vector(
  query_vector    vector(384),
  p_customer_id   text,
  p_model         text,
  p_threshold     float DEFAULT 0.6,
  p_limit         int   DEFAULT 1
)
RETURNS TABLE (
  context_id  text,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    context_id,
    1 - (context_vector <=> query_vector) AS similarity
  FROM dim_contexts
  WHERE customer_id    = p_customer_id
    AND context_vector IS NOT NULL
    AND embedding_model = p_model
    AND embedding_schema_version = 2
    AND 1 - (context_vector <=> query_vector) > p_threshold
  ORDER BY context_vector <=> query_vector
  LIMIT p_limit;
$$;
