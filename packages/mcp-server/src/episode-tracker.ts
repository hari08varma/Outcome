/**
 * LayerInfinite MCP Server — episode-tracker.ts
 * ══════════════════════════════════════════════════════════════
 * Gap Fix #2: Redirect Loop Prevention
 *
 * Tracks tried/failed actions per episode to prevent redirect loops
 * in assist/auto modes. When auto mode redirects from A to B and B
 * fails, the fallback logic must not redirect back to A.
 *
 * Entries expire after 30 minutes to prevent memory leaks.
 * ══════════════════════════════════════════════════════════════
 */

const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

interface EpisodeEntry {
  triedActions: Set<string>;
  createdAt: number;
}

/**
 * Lightweight in-memory tracker for actions tried within an episode.
 * Not persisted — if the MCP server restarts, episodes start fresh.
 * This is acceptable because episodes are short-lived (minutes, not hours).
 */
export class EpisodeTracker {
  private readonly episodes = new Map<string, EpisodeEntry>();

  /** Record that an action was tried in this episode. */
  markTried(episodeId: string, actionName: string): void {
    this.cleanExpired();
    let entry = this.episodes.get(episodeId);
    if (!entry) {
      entry = { triedActions: new Set(), createdAt: Date.now() };
      this.episodes.set(episodeId, entry);
    }
    entry.triedActions.add(actionName);
  }

  /** Get all tried actions for an episode. */
  getTriedActions(episodeId: string): ReadonlySet<string> {
    this.cleanExpired();
    return this.episodes.get(episodeId)?.triedActions ?? new Set();
  }

  /** Check if an action has already been tried in this episode. */
  hasTried(episodeId: string, actionName: string): boolean {
    return this.getTriedActions(episodeId).has(actionName);
  }

  /** Remove expired entries to prevent memory leaks. */
  private cleanExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.episodes) {
      if (now - entry.createdAt > EXPIRY_MS) {
        this.episodes.delete(id);
      }
    }
  }
}
