-- Migration: Persistent Rate Limit Store
-- Replaces in-memory Node.js rate limit buckets which reset on deploy
-- Enables resilient rate limiting across scaled API containers

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    api_key_hash TEXT PRIMARY KEY,
    tokens FLOAT NOT NULL DEFAULT 200,
    last_refill_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tier TEXT NOT NULL DEFAULT 'free',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for background cleanup of stale buckets
CREATE INDEX IF NOT EXISTS idx_rate_limit_last_refill ON rate_limit_buckets(last_refill_at);

-- Enable RLS (allow full access to service role)
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on rate limits" ON rate_limit_buckets;

CREATE POLICY "Service role full access on rate limits" 
ON rate_limit_buckets
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Background worker rule (via pg_cron if enabled, or application-side cleanup) 
-- Delete buckets completely idle for more than 2 hours to prevent unbounded table growth
-- DELETE FROM rate_limit_buckets WHERE last_refill_at < now() - INTERVAL '2 hours';
