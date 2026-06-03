/**
 * LayerInfinite MCP Server — enrichment/score-fetcher.ts
 * ══════════════════════════════════════════════════════════════
 * Cache-aware score fetching from LI API. Uses in-memory LRU
 * with 5-min TTL to avoid blocking agents on every tools/list.
 * Cold-start safe: returns empty array when no scores available.
 * ══════════════════════════════════════════════════════════════
 */

import type { LiApiClient } from '../rest-client.js';
import type { ScoredAction } from '../types.js';
import { logger } from '../logger.js';

const log = logger.forTool('score-fetcher');

const MAX_CACHE_SIZE = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const FETCH_TIMEOUT_MS = 500;

interface CacheEntry {
  scores: ScoredAction[];
  accessedAt: number;
}

export class ScoreFetcher {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly liApi: LiApiClient) {}

  /** Get scores for a task type. Returns empty array on cold start or timeout. */
  async getScores(
    taskType: string,
    customerId: string,
    agentId: string,
  ): Promise<ScoredAction[]> {
    const key = `${customerId}:${taskType}`;
    const cached = this.cache.get(key);

    // Return cache hit if fresh
    if (cached && Date.now() - cached.accessedAt < CACHE_TTL_MS) {
      cached.accessedAt = Date.now();
      return cached.scores;
    }

    // Fetch with tight timeout — never block the agent
    try {
      const scores = await this.fetchWithTimeout(taskType, customerId, agentId);
      this.setCache(key, scores);
      return scores;
    } catch (err) {
      log.warn('Score fetch failed, returning cached or empty', {
        taskType,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return stale cache if available, otherwise empty
      return cached?.scores ?? [];
    }
  }

  /** Clear the score cache. Useful on config changes. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Warm the cache proactively (called at startup or after training). */
  async warm(taskType: string, customerId: string, agentId: string): Promise<void> {
    try {
      const scores = await this.liApi.getScores(taskType, customerId, agentId);
      this.setCache(`${customerId}:${taskType}`, scores);
    } catch {
      // Warm is best-effort
    }
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  private setCache(key: string, scores: ScoredAction[]): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= MAX_CACHE_SIZE) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, { scores, accessedAt: Date.now() });
  }

  private async fetchWithTimeout(
    taskType: string,
    customerId: string,
    agentId: string,
  ): Promise<ScoredAction[]> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const promise = this.liApi.getScores(taskType, customerId, agentId);
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timeout = undefined;
            reject(new Error('Score fetch timed out'));
          }, FETCH_TIMEOUT_MS);
        }),
      ]);
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
