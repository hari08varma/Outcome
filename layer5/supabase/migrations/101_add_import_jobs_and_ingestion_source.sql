-- ============================================================
-- LAYERINFINITE — Migration 101
-- Add ingestion_source + import_jobs for historical import feature
-- ============================================================
--
-- Changes:
--   1. fact_outcomes.ingestion_source  — 'sdk' | 'import' (default 'sdk')
--   2. fact_outcomes.import_job_id     — FK to import_jobs
--   3. fact_outcomes.source_event_at   — original log timestamp from imported file
--   4. import_jobs table               — async job state tracker
--   5. Trust-updater guard             — existing batch trust queries get is NOT DISTINCT FROM 'sdk'
--      guard applied at application level (trust-updater edge function + outcome-orchestrator)
--      via ingestion_source column.
--
-- Safety:
--   - All new columns have DEFAULT values so existing rows are unaffected.
--   - import_jobs.import_job_id FK is SET NULL on delete (no orphan cascade).
--   - Uses standard CREATE INDEX for Supabase transaction compatibility.
--   - Optional post-deploy CONCURRENT index can be created manually if needed.
-- ============================================================

-- ── Step 1: Create import_jobs table ─────────────────────────
CREATE TABLE IF NOT EXISTS import_jobs (
    job_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     text        NOT NULL,
    agent_id        text        NOT NULL,
    status          text        NOT NULL DEFAULT 'queued',
        -- queued | running | done | failed | blocked
    queued_rows     int         NOT NULL DEFAULT 0,
    rows_processed  int         NOT NULL DEFAULT 0,
    rows_failed     int         NOT NULL DEFAULT 0,
    errors          jsonb       NOT NULL DEFAULT '[]',
    quality_summary jsonb,
    task_clusters   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    CONSTRAINT import_jobs_status_check CHECK (
        status IN ('queued', 'running', 'done', 'failed', 'blocked')
    )
);

CREATE INDEX IF NOT EXISTS import_jobs_customer_agent_idx
    ON import_jobs (customer_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS import_jobs_status_idx
    ON import_jobs (status)
    WHERE status IN ('queued', 'running');

-- ── Step 2: Add ingestion_source to fact_outcomes ─────────────
ALTER TABLE fact_outcomes
    ADD COLUMN IF NOT EXISTS ingestion_source text NOT NULL DEFAULT 'sdk';

ALTER TABLE fact_outcomes
    ADD CONSTRAINT fact_outcomes_ingestion_source_check
        CHECK (ingestion_source IN ('sdk', 'import'))
        NOT VALID;  -- NOT VALID: skip row-by-row scan on large existing tables

-- Validate asynchronously (run in a separate transaction if needed):
-- ALTER TABLE fact_outcomes VALIDATE CONSTRAINT fact_outcomes_ingestion_source_check;

-- ── Step 3: Add import_job_id to fact_outcomes ────────────────
ALTER TABLE fact_outcomes
    ADD COLUMN IF NOT EXISTS import_job_id uuid
        REFERENCES import_jobs(job_id) ON DELETE SET NULL;

-- ── Step 4: Add source_event_at to fact_outcomes ─────────────
-- Stores the original timestamp from the imported log file.
-- NULL for SDK-originated rows (they use the system timestamp column).
ALTER TABLE fact_outcomes
    ADD COLUMN IF NOT EXISTS source_event_at timestamptz;

-- NOTE: Supabase migration execution can run inside a transaction block.
-- CREATE INDEX CONCURRENTLY is forbidden in that mode (ERROR 25001), so
-- this migration uses a standard index create for compatibility.
--
-- If the table is very large in production and lock sensitivity is high,
-- run a follow-up manual CREATE INDEX CONCURRENTLY outside the migration
-- transaction window.
CREATE INDEX IF NOT EXISTS fact_outcomes_ingestion_source_agent_idx
    ON fact_outcomes (agent_id, ingestion_source, timestamp DESC)
    WHERE ingestion_source = 'sdk';

-- ── Step 6: Backfill existing rows (all are SDK-originated) ──
-- Already handled by DEFAULT 'sdk' above — no explicit UPDATE needed.
-- The DEFAULT applies to all existing rows at the column level.

-- ── Step 7: Update trigger for import_jobs.updated_at ────────
CREATE OR REPLACE FUNCTION update_import_jobs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_import_jobs_updated_at ON import_jobs;
CREATE TRIGGER trg_import_jobs_updated_at
    BEFORE UPDATE ON import_jobs
    FOR EACH ROW EXECUTE FUNCTION update_import_jobs_updated_at();

-- ── Step 8: RLS for import_jobs (customer-scoped) ────────────
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — API uses service role key.
-- Dashboard users access via the API, not direct DB.
-- No additional policies needed for current architecture.

COMMENT ON TABLE import_jobs IS
    'Tracks async historical log import jobs. Each row = one file upload by a customer.';

COMMENT ON COLUMN fact_outcomes.ingestion_source IS
    'Origin of this outcome row. sdk = real-time SDK; import = historical file upload. '
    'Trust-update paths (orchestrator + batch cron) only process sdk rows.';

COMMENT ON COLUMN fact_outcomes.import_job_id IS
    'FK to import_jobs when ingestion_source = import. NULL for SDK rows.';

COMMENT ON COLUMN fact_outcomes.source_event_at IS
    'Original event timestamp from the imported log file. '
    'NULL for SDK rows (use the timestamp column instead). '
    'Populated during import to preserve historical recency ordering.';
