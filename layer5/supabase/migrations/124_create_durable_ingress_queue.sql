-- ============================================================
-- LAYERINFINITE — Migration 124: Durable Outcome Ingress Queue
-- ============================================================
-- Replaces the volatile in-memory array queue with a Postgres-
-- backed durable message queue. Uses FOR UPDATE SKIP LOCKED for
-- concurrent worker claim semantics.
--
-- State machine:
--   pending → processing → succeeded
--                       → failed (retries until max_attempts)
--                       → dead   (poison pill quarantine)
--
-- Zero new infrastructure required — runs inside existing Supabase.
-- ============================================================

-- ── Queue table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_outcome_ingress (
    ingress_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id      UUID NOT NULL,
    agent_id         UUID NOT NULL,
    idempotency_key  TEXT,
    payload          JSONB NOT NULL,
    validated_action JSONB,

    -- State machine
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
    attempts         INT  NOT NULL DEFAULT 0,
    max_attempts     INT  NOT NULL DEFAULT 5,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_by        TEXT,
    locked_at        TIMESTAMPTZ,
    last_error       TEXT,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ
);

-- Worker poll: find oldest unlocked pending/failed items efficiently.
-- Partial index keeps the B-tree small — succeeded/dead rows are excluded.
CREATE INDEX IF NOT EXISTS idx_queue_ingress_poll
    ON queue_outcome_ingress (status, next_attempt_at)
    WHERE status IN ('pending', 'failed');

-- Dead-letter monitoring: quickly count/inspect poison pills.
CREATE INDEX IF NOT EXISTS idx_queue_ingress_dead
    ON queue_outcome_ingress (status, created_at)
    WHERE status = 'dead';

-- Idempotency guard: prevent duplicate SDK submissions at the queue layer.
-- Only enforced for rows that have NOT yet been processed (pending/failed).
-- Succeeded/dead rows are excluded so the constraint doesn't block resubmission
-- after a previous success (idempotent replay is handled by fact_outcome_idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_ingress_idempotency
    ON queue_outcome_ingress (customer_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
      AND status IN ('pending', 'processing', 'failed');

-- ── Cleanup: auto-purge succeeded rows older than 24 hours ───
-- Keeps the table lean. Dead rows are preserved indefinitely for inspection.
CREATE OR REPLACE FUNCTION purge_succeeded_queue_ingress()
RETURNS void AS $$
BEGIN
    DELETE FROM queue_outcome_ingress
    WHERE status = 'succeeded'
      AND completed_at < now() - interval '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Schedule hourly cleanup via pg_cron (if available; safe no-op if not).
DO $$
BEGIN
    PERFORM cron.schedule(
        'purge-queue-ingress-succeeded',
        '17 * * * *',
        'SELECT purge_succeeded_queue_ingress()'
    );
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not available — skip purge schedule. Run purge_succeeded_queue_ingress() manually or via app-level cron.';
END $$;

-- ── RLS: service_role only (no user-facing access) ───────────
ALTER TABLE queue_outcome_ingress ENABLE ROW LEVEL SECURITY;

-- Allow full access ONLY to service_role (backend server key)
CREATE POLICY queue_ingress_service_only ON queue_outcome_ingress
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Explicitly deny anon and authenticated roles
CREATE POLICY queue_ingress_deny_anon ON queue_outcome_ingress
    FOR ALL
    TO anon
    USING (false)
    WITH CHECK (false);

CREATE POLICY queue_ingress_deny_authenticated ON queue_outcome_ingress
    FOR ALL
    TO authenticated
    USING (false)
    WITH CHECK (false);
