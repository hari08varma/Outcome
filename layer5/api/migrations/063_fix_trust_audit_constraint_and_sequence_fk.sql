-- ══════════════════════════════════════════════════════════════
-- Migration 063 — Fix event_type check constraint + sequence FK
-- Run once in Supabase SQL Editor.
-- ══════════════════════════════════════════════════════════════

-- ── Fix A: agent_trust_audit event_type check constraint ──────
--
-- The update_trust_and_audit() RPC passes event_type = 'success'
-- or 'failure', but the check constraint doesn't allow these values.
-- This block auto-detects ALL existing values in the table so no
-- existing row is violated, then adds the new required values.

ALTER TABLE agent_trust_audit
DROP CONSTRAINT IF EXISTS agent_trust_audit_event_type_check;

DO $$
DECLARE
    all_values text;
BEGIN
    -- Union of: every value already stored + new required values
    SELECT string_agg(DISTINCT quote_literal(v), ', ')
    INTO all_values
    FROM (
        SELECT event_type AS v
        FROM agent_trust_audit
        WHERE event_type IS NOT NULL
        UNION
        SELECT unnest(ARRAY[
            'success',
            'failure',
            'failure_excluded_infrastructure',
            'manual_override',
            'status_change'
        ])
    ) t;

    EXECUTE
        'ALTER TABLE agent_trust_audit '
        'ADD CONSTRAINT agent_trust_audit_event_type_check '
        'CHECK (event_type IN (' || all_values || '))';

    RAISE NOTICE 'Constraint recreated with values: %', all_values;
END $$;

-- ── Fix B: action_sequences episode_id FK ─────────────────────
--
-- action_sequences.episode_id has a FK to fact_episodes.
-- SDK-generated episode UUIDs don't exist in fact_episodes,
-- so every upsertSequence() INSERT fails with FK 23503.
-- episode_id here is a loose grouping key — no FK needed.
-- (Same design as fact_outcomes.episode_id fixed in migration 062.)

ALTER TABLE action_sequences
DROP CONSTRAINT IF EXISTS action_sequences_episode_id_fkey;

-- ── Verify ────────────────────────────────────────────────────
SELECT
    'agent_trust_audit_event_type_check' AS constraint_name,
    pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname = 'agent_trust_audit_event_type_check'

UNION ALL

SELECT
    'action_sequences_episode_id_fkey' AS constraint_name,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'action_sequences_episode_id_fkey'
        )
        THEN 'STILL EXISTS — drop failed'
        ELSE 'DROPPED ✓'
    END AS definition;
