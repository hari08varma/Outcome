BEGIN;

-- Ensure unique context per (customer, issue_type, environment).
-- This is the onConflict target used by upsertContext() in
-- context-embed.ts. Without this, upsert creates duplicate rows.
--
-- CONCURRENTLY omitted: migration runs at deploy time, not online.
-- If concurrent inserts are in flight, run this during a maintenance
-- window or with CREATE UNIQUE INDEX CONCURRENTLY in a separate step.

CREATE UNIQUE INDEX IF NOT EXISTS idx_dim_contexts_tenant_unique
  ON dim_contexts(customer_id, issue_type, environment);

-- If a matching constraint already exists under a different name,
-- this will fail with "already exists" — check \d dim_contexts
-- in psql before running. Drop the old constraint first if needed.

COMMIT;
