-- Migration: Re-hash plaintext API keys using SHA-256
-- Protects existing plaintext keys stored in dim_agents
-- Idempotent: safe to run multiple times, only acts on unconverted keys

DO $$
BEGIN
    -- Check if there are keys that don't match exactly 64 characters of hex (SHA-256 length)
    -- This assumes previous plaintext keys were short/UUID format or not 64 valid hex chars.
    -- (A simple length check works since plaintext keys have a different length)
    
    -- Note: Ensure pgcrypto is enabled.
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    UPDATE dim_agents
    SET api_key_hash = encode(digest(api_key_hash, 'sha256'), 'hex'),
        updated_at = NOW()
    WHERE length(api_key_hash) != 64; 
    -- Assuming a valid SHA-256 hex digest is exactly 64 characters long.
END $$;
