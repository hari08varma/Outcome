/**
 * LayerInfinite API — coach-session-tracker.ts
 * ══════════════════════════════════════════════════════════════
 * Session-level coaching limits for the LLM Coach.
 *
 * Rules:
 *   - Max 3 coaching injections per agent session
 *   - Sessions expire after 30 minutes of inactivity
 *   - Coaching retires automatically when a task_type has
 *     ≥ 50 outcomes (statistical scoring is sufficient)
 *
 * Durability:
 *   - In-memory Map is the primary fast path
 *   - DB-backed fallback prevents cap reset on server restart:
 *     writes are fire-and-forget, reads happen only on cold miss
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

interface CoachSessionState {
  agentId: string;
  sessionStart: number;
  coachingCount: number;
  /** Per-task-type outcome counts known at coaching time. */
  taskOutcomeCounts: Map<string, number>;
}

const MAX_COACHING_PER_SESSION = 3;
const SESSION_TTL_MS = 30 * 60 * 1000;
const RETIRE_OUTCOME_THRESHOLD = 50;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// ── DB helpers (fire-and-forget, never block the hot path) ────

async function persistCoachingToDB(agentId: string, sessionStart: number, count: number): Promise<void> {
    try {
        await supabase
            .from('coach_session_state')
            .upsert({
                agent_id: agentId,
                session_start: new Date(sessionStart).toISOString(),
                coaching_count: count,
                last_coaching_at: new Date().toISOString(),
            }, {
                onConflict: 'agent_id,session_start',
                ignoreDuplicates: false,
            });
    } catch {
        // Fire-and-forget — DB unavailability must never block coaching
    }
}

async function recoverCountFromDB(agentId: string, sessionStart: number): Promise<number> {
    try {
        const { data } = await supabase
            .from('coach_session_state')
            .select('coaching_count')
            .eq('agent_id', agentId)
            .eq('session_start', new Date(sessionStart).toISOString())
            .maybeSingle();

        return typeof (data as any)?.coaching_count === 'number' ? (data as any).coaching_count : -1;
    } catch {
        return -1;
    }
}

async function cleanupDB(): Promise<void> {
    try {
        const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
        await supabase
            .from('coach_session_state')
            .delete()
            .lt('session_start', cutoff);
    } catch {
        // Best-effort — stale rows are harmless (session_start won't match on recovery)
    }
}

export class CoachSessionTracker {
  private readonly sessions = new Map<string, CoachSessionState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Check whether coaching is allowed for this agent + task_type.
   * Returns false if the session cap (3) is reached or if the
   * task_type has enough historical outcomes for statistical scoring.
   * Falls back to DB on cold start when in-memory session is missing.
   */
  async canCoach(agentId: string, taskType: string, taskOutcomeCount = 0): Promise<boolean> {
    this.cleanExpired();

    if (taskOutcomeCount >= RETIRE_OUTCOME_THRESHOLD) return false;

    const memState = this.sessions.get(agentId);
    if (memState) {
      return memState.coachingCount < MAX_COACHING_PER_SESSION;
    }

    // Cold start — try DB recovery before creating a fresh session
    const recoveredCount = await recoverCountFromDB(agentId, Date.now());
    if (recoveredCount >= 0 && recoveredCount < MAX_COACHING_PER_SESSION) {
      // Recover session state from DB floor
      const recovered: CoachSessionState = {
        agentId,
        sessionStart: Date.now(),
        coachingCount: recoveredCount,
        taskOutcomeCounts: new Map(),
      };
      this.sessions.set(agentId, recovered);
      return true;
    }

    return true; // no session at all — coaching is allowed
  }

  /**
   * Record a coaching injection. Returns true if recorded,
   * false if the cap was already reached.
   * Persists to DB as fire-and-forget for cold-start recovery.
   */
  recordCoaching(agentId: string, taskType: string): boolean {
    this.cleanExpired();

    const state = this.getOrCreate(agentId);
    if (state.coachingCount >= MAX_COACHING_PER_SESSION) return false;

    state.coachingCount++;
    state.taskOutcomeCounts.set(
      taskType,
      (state.taskOutcomeCounts.get(taskType) ?? 0) + 1,
    );

    // Fire-and-forget DB persistence — never blocks the hot path
    persistCoachingToDB(agentId, state.sessionStart, state.coachingCount);

    return true;
  }

  /**
   * Update the known outcome count for a task_type.
   * Once ≥ 50, coaching retires for that task_type permanently.
   */
  setTaskOutcomeCount(agentId: string, taskType: string, count: number): void {
    const state = this.getOrCreate(agentId);
    state.taskOutcomeCounts.set(taskType, count);
  }

  /** Remaining coaching slots for this agent's current session. */
  remainingCoachingSlots(agentId: string): number {
    this.cleanExpired();
    const state = this.sessions.get(agentId);
    if (!state) return MAX_COACHING_PER_SESSION;
    return Math.max(0, MAX_COACHING_PER_SESSION - state.coachingCount);
  }

  get activeSessionCount(): number {
    this.cleanExpired();
    return this.sessions.size;
  }

  // ── Private ──────────────────────────────────────────────────

  private getOrCreate(agentId: string): CoachSessionState {
    const existing = this.sessions.get(agentId);
    if (existing) return existing;

    const state: CoachSessionState = {
      agentId,
      sessionStart: Date.now(),
      coachingCount: 0,
      taskOutcomeCounts: new Map(),
    };
    this.sessions.set(agentId, state);

    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanExpired(), CLEANUP_INTERVAL_MS).unref();
    }

    return state;
  }

  private cleanExpired(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, state] of this.sessions) {
      if (state.sessionStart < cutoff) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Also cleanup stale DB rows (best-effort, throttled by the 5-min cleanup interval)
    cleanupDB().catch(() => {});
  }
}

/** Singleton instance for the process. */
export const coachTracker = new CoachSessionTracker();
