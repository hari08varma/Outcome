-- ═══════════════════════════════════════════════════════════════
-- Migration 132: Extend ingestion_source to include 'mcp'
-- ═══════════════════════════════════════════════════════════════
-- V2 Gateway proxies tool calls and logs outcomes automatically.
-- Outcomes originating from the MCP gateway need an 'mcp' source
-- distinct from legacy 'sdk' (agent SDK) and 'import' (bulk upload).
--
-- This is a non-breaking extension: existing 'sdk' and 'import'
-- values remain valid. No data migration needed.
-- ═══════════════════════════════════════════════════════════════

-- Step 1: Drop the existing constraint (if it exists)
ALTER TABLE fact_outcomes
    DROP CONSTRAINT IF EXISTS fact_outcomes_ingestion_source_check;

-- Step 2: Re-add with 'mcp' allowed
ALTER TABLE fact_outcomes
    ADD CONSTRAINT fact_outcomes_ingestion_source_check
        CHECK (ingestion_source IN ('sdk', 'import', 'mcp'))
        NOT VALID;  -- NOT VALID: skip row scan on existing data — all existing rows already pass

-- Step 3: Validate asynchronously (run separately if table is large)
-- ALTER TABLE fact_outcomes VALIDATE CONSTRAINT fact_outcomes_ingestion_source_check;

-- Step 4: Update column comment
COMMENT ON COLUMN fact_outcomes.ingestion_source IS
    'Origin of outcome: sdk (legacy agent SDK), import (bulk historical upload), mcp (V2 gateway proxy)';

-- Note: The partial index in migration 101 (WHERE ingestion_source = ''sdk'')
-- is still valid — it just won't cover 'mcp' rows. A new partial index for
-- 'mcp' rows can be added later if query patterns require it.
