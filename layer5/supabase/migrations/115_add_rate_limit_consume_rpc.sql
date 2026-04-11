-- ============================================================
-- LAYERINFINITE -- Migration 115: DB-backed rate-limit consume RPC
-- ============================================================
-- Purpose:
--   Provide an atomic per-bucket consume operation so rate limiting
--   is consistent across multiple API instances.
--
-- Notes:
--   - Uses existing rate_limit_buckets table from migration 038.
--   - Uses fixed-window semantics controlled by p_window_ms/p_max_requests.
--   - Bucket key is supplied by API middleware (hashed customer key).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION consume_rate_limit_bucket(
    p_bucket_key TEXT,
    p_window_ms INTEGER,
    p_max_requests INTEGER,
    p_tier TEXT DEFAULT 'pro'
)
RETURNS TABLE (
    allowed BOOLEAN,
    retry_after_ms INTEGER,
    remaining INTEGER,
    window_expiry TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_window INTERVAL;
    v_tokens DOUBLE PRECISION;
    v_window_expiry TIMESTAMPTZ;
    v_effective_tier TEXT;
BEGIN
    IF p_bucket_key IS NULL OR btrim(p_bucket_key) = '' THEN
        RAISE EXCEPTION 'consume_rate_limit_bucket: p_bucket_key is required';
    END IF;

    IF p_window_ms IS NULL OR p_window_ms <= 0 THEN
        RAISE EXCEPTION 'consume_rate_limit_bucket: p_window_ms must be > 0';
    END IF;

    IF p_max_requests IS NULL OR p_max_requests <= 0 THEN
        RAISE EXCEPTION 'consume_rate_limit_bucket: p_max_requests must be > 0';
    END IF;

    v_window := (p_window_ms::TEXT || ' milliseconds')::INTERVAL;
    v_effective_tier := COALESCE(NULLIF(btrim(p_tier), ''), 'pro');

    INSERT INTO rate_limit_buckets (
        api_key_hash,
        tokens,
        last_refill_at,
        tier,
        updated_at,
        window_expiry,
        last_touched
    )
    VALUES (
        p_bucket_key,
        GREATEST(p_max_requests - 1, 0),
        v_now,
        v_effective_tier,
        v_now,
        v_now + v_window,
        v_now
    )
    ON CONFLICT (api_key_hash) DO NOTHING;

    SELECT
        rlb.tokens,
        rlb.window_expiry
    INTO
        v_tokens,
        v_window_expiry
    FROM rate_limit_buckets rlb
    WHERE rlb.api_key_hash = p_bucket_key
    FOR UPDATE;

    IF v_window_expiry IS NULL OR v_window_expiry <= v_now THEN
        UPDATE rate_limit_buckets
        SET
            tokens = GREATEST(p_max_requests - 1, 0),
            last_refill_at = v_now,
            tier = v_effective_tier,
            updated_at = v_now,
            window_expiry = v_now + v_window,
            last_touched = v_now
        WHERE api_key_hash = p_bucket_key
        RETURNING rate_limit_buckets.window_expiry
        INTO v_window_expiry;

        RETURN QUERY SELECT
            TRUE,
            0,
            GREATEST(p_max_requests - 1, 0),
            v_window_expiry;
        RETURN;
    END IF;

    IF COALESCE(v_tokens, 0) <= 0 THEN
        RETURN QUERY SELECT
            FALSE,
            GREATEST(
                CEIL(EXTRACT(EPOCH FROM (v_window_expiry - v_now)) * 1000)::INTEGER,
                0
            ),
            0,
            v_window_expiry;
        RETURN;
    END IF;

    UPDATE rate_limit_buckets
    SET
        tokens = GREATEST(v_tokens - 1, 0),
        tier = v_effective_tier,
        updated_at = v_now,
        last_touched = v_now
    WHERE api_key_hash = p_bucket_key
    RETURNING rate_limit_buckets.tokens, rate_limit_buckets.window_expiry
    INTO v_tokens, v_window_expiry;

    RETURN QUERY SELECT
        TRUE,
        0,
        GREATEST(FLOOR(v_tokens)::INTEGER, 0),
        v_window_expiry;
END;
$$;

GRANT EXECUTE ON FUNCTION consume_rate_limit_bucket(
    TEXT,
    INTEGER,
    INTEGER,
    TEXT
) TO service_role;

COMMIT;

-- Verification
SELECT routine_name, routine_type, security_type
FROM information_schema.routines
WHERE routine_name = 'consume_rate_limit_bucket'
  AND routine_schema = 'public';
