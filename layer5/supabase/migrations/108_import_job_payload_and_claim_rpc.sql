-- ============================================================
-- LAYERINFINITE — Migration 108: Durable import payload + claim RPC
-- ============================================================
-- Why:
--   Import jobs were previously processed from in-memory parsed rows only.
--   Process restarts could strand queued/running jobs with no way to resume.
--
-- This migration:
--   1) Adds import_jobs.payload JSONB to persist normalized rows.
--   2) Adds claim_import_job() RPC for atomic queued/stale-running claims.
--   3) Adds recovery index for queued/stale lookup scans.
--
-- Safety:
--   - Fully additive / idempotent.
--   - claim_import_job uses FOR UPDATE SKIP LOCKED to avoid duplicate claims.
-- ============================================================

BEGIN;

ALTER TABLE import_jobs
    ADD COLUMN IF NOT EXISTS payload jsonb;

COMMENT ON COLUMN import_jobs.payload IS
    'Serialized normalized import rows for durable async processing/recovery. Cleared after terminal completion.';

CREATE OR REPLACE FUNCTION claim_import_job(
    p_job_id uuid,
    p_stale_after_minutes integer DEFAULT 10
)
RETURNS TABLE (
    job_id uuid,
    customer_id text,
    payload jsonb,
    queued_rows integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_stale interval := make_interval(mins => GREATEST(1, COALESCE(p_stale_after_minutes, 10)));
BEGIN
    RETURN QUERY
    WITH candidate AS (
        SELECT ij.job_id
        FROM import_jobs ij
        WHERE ij.job_id = p_job_id
          AND (
              ij.status = 'queued'
              OR (ij.status = 'running' AND ij.updated_at < (now() - v_stale))
          )
        FOR UPDATE SKIP LOCKED
    ), claimed AS (
        UPDATE import_jobs ij
           SET status = 'running',
               updated_at = now()
          FROM candidate c
         WHERE ij.job_id = c.job_id
        RETURNING ij.job_id, ij.customer_id, ij.payload, ij.queued_rows
    )
    SELECT claimed.job_id, claimed.customer_id, claimed.payload, claimed.queued_rows
    FROM claimed;
END;
$$;

COMMENT ON FUNCTION claim_import_job(uuid, integer) IS
    'Atomically claims a queued/stale import job and returns persisted payload rows for recovery-safe processing.';

CREATE INDEX IF NOT EXISTS import_jobs_recovery_lookup_idx
    ON import_jobs (status, updated_at, created_at DESC)
    WHERE status IN ('queued', 'running');

COMMIT;
