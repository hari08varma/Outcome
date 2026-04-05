-- ══════════════════════════════════════════════════════════════
-- Migration 064 — Rewrite mv_episode_patterns to use action_sequences
-- ══════════════════════════════════════════════════════════════
--
-- Root cause: mv_episode_patterns reads from fact_episodes, but
-- the application never writes to fact_episodes. The actual
-- episode data lives in action_sequences (populated by the
-- upsertSequence/closeSequence orchestrator) and fact_outcomes
-- (which stores episode_id since migration 063).
--
-- Fix: Drop and recreate the MV to read from action_sequences
-- joined with fact_outcomes for context_id/customer_id lookup.
-- ══════════════════════════════════════════════════════════════

-- Step 1: Drop the existing index (required before dropping MV)
DROP INDEX IF EXISTS ux_episode_patterns_composite;

-- Step 2: Drop the existing materialized view
DROP MATERIALIZED VIEW IF EXISTS mv_episode_patterns;

-- Step 3: Recreate from action_sequences + fact_outcomes
CREATE MATERIALIZED VIEW mv_episode_patterns AS
SELECT
    fo.context_id,
    fo.customer_id,
    -- Convert text[] to jsonb to match the original schema contract
    to_jsonb(aseq.action_sequence)                              AS action_sequence,
    md5(to_jsonb(aseq.action_sequence)::text)                  AS action_sequence_hash,
    round(avg(
        CASE WHEN COALESCE(aseq.final_outcome, 0) >= 0.5 THEN 1.0 ELSE 0.0 END
    ), 4)                                                       AS episode_success_rate,
    round(avg(aseq.total_response_ms), 0)                      AS avg_duration_ms,
    count(*)                                                    AS sample_count,
    max(aseq.closed_at)                                        AS last_seen_at,
    now()                                                       AS view_refreshed_at
FROM action_sequences aseq
-- One representative fact_outcomes row per episode for context/customer lookup
JOIN (
    SELECT DISTINCT ON (episode_id)
        episode_id,
        context_id,
        customer_id
    FROM fact_outcomes
    WHERE episode_id IS NOT NULL
    ORDER BY episode_id, timestamp
) fo ON fo.episode_id = aseq.episode_id
WHERE
    aseq.resolved       = true
    AND aseq.action_sequence IS NOT NULL
    AND array_length(aseq.action_sequence, 1) > 0
    AND aseq.closed_at  IS NOT NULL
GROUP BY
    fo.context_id,
    fo.customer_id,
    aseq.action_sequence
HAVING count(*) >= 1
WITH DATA;

-- Step 4: Recreate the unique index (required for CONCURRENT refresh)
CREATE UNIQUE INDEX ux_episode_patterns_composite
    ON mv_episode_patterns (context_id, customer_id, action_sequence_hash);

-- Step 5: Verify
SELECT
    context_id,
    customer_id,
    action_sequence,
    episode_success_rate,
    sample_count,
    last_seen_at
FROM mv_episode_patterns
ORDER BY sample_count DESC, last_seen_at DESC;
