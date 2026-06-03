-- ============================================================
-- LAYERINFINITE — Migration 134: Coach Session Persistence
-- ============================================================
-- Lightweight table for persisting LLM coach session state
-- across server restarts. The in-memory CoachSessionTracker
-- is the primary path; this table acts as a cold-start floor
-- so that server restart doesn't reset coaching caps.
-- ============================================================

CREATE TABLE IF NOT EXISTS coach_session_state (
    agent_id        UUID NOT NULL,
    session_start   TIMESTAMPTZ NOT NULL DEFAULT now(),
    coaching_count  INT NOT NULL DEFAULT 0,
    last_coaching_at TIMESTAMPTZ,

    CONSTRAINT pk_coach_session_state PRIMARY KEY (agent_id, session_start)
);

-- Sessions expire after 30 min — rows older than that are
-- ignored by the tracker. Periodic cleanup is handled by the
-- tracker itself; no external cron needed.
CREATE INDEX IF NOT EXISTS idx_coach_session_start
    ON coach_session_state (session_start DESC);
