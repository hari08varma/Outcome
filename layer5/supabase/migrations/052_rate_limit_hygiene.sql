-- ============================================================
-- LAYERINFINITE — Migration 052: Rate Limit Store Hygiene
-- Adds TTL expiry fields, automated cleanup function,
-- fast approximate cardinality helper, and LRU eviction.
-- ============================================================

-- Add TTL and LRU tracking columns
ALTER TABLE rate_limit_buckets
  ADD COLUMN IF NOT EXISTS window_expiry  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_touched   TIMESTAMPTZ DEFAULT NOW();

-- Backfill: existing rows get 2-minute expiry from last refill
UPDATE rate_limit_buckets
  SET window_expiry = last_refill_at + INTERVAL '2 minutes',
      last_touched  = last_refill_at
  WHERE window_expiry IS NULL;

-- Index for efficient reaper scans
CREATE INDEX IF NOT EXISTS idx_rate_limit_expiry
  ON rate_limit_buckets(window_expiry)
  WHERE window_expiry IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rate_limit_last_touched
  ON rate_limit_buckets(last_touched ASC);

-- Reaper function: removes expired buckets, then evicts LRU if near capacity.
-- Called every minute by pg_cron (migration 053).
CREATE OR REPLACE FUNCTION cleanup_rate_limit_buckets()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_count BIGINT;
  v_evict_count BIGINT;
BEGIN
  -- Phase 1: remove buckets past expiry + 2-minute grace period
  DELETE FROM rate_limit_buckets
    WHERE window_expiry IS NOT NULL
      AND NOW() > window_expiry + INTERVAL '2 minutes';

  -- Phase 2: LRU eviction if approaching 1M ceiling (> 800K = 80%)
  SELECT get_rate_limit_bucket_count() INTO v_count;
  IF v_count > 800000 THEN
    -- Evict oldest-touched until utilisation drops to 75% (750K)
    v_evict_count := v_count - 750000;
    DELETE FROM rate_limit_buckets
      WHERE api_key_hash IN (
        SELECT api_key_hash
        FROM rate_limit_buckets
        ORDER BY last_touched ASC NULLS FIRST
        LIMIT v_evict_count
      );
  END IF;
END;
$$;

-- Fast approximate row count via pg_stat (O(1), cached, avoids sequential scan)
CREATE OR REPLACE FUNCTION get_rate_limit_bucket_count()
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(n_live_tup, 0)
  FROM pg_stat_user_tables
  WHERE relname = 'rate_limit_buckets';
$$;
