import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScoreFetcher } from '../src/enrichment/score-fetcher.js';
import type { LiApiClient } from '../src/rest-client.js';
import type { ScoredAction } from '../src/types.js';

function makeScores(): ScoredAction[] {
  return [
    { actionName: 'tool_a', compositeScore: 0.9, successRate: 0.8, sampleSize: 50 },
    { actionName: 'tool_b', compositeScore: 0.6, successRate: 0.5, sampleSize: 30 },
  ];
}

function mockLiApi(scores: ScoredAction[] = makeScores()): LiApiClient {
  return { getScores: vi.fn().mockResolvedValue(scores) } as unknown as LiApiClient;
}

describe('ScoreFetcher', () => {
  let fetcher: ScoreFetcher;
  let liApi: LiApiClient;

  beforeEach(() => {
    liApi = mockLiApi();
    fetcher = new ScoreFetcher(liApi);
  });

  it('fetches scores from API', async () => {
    const scores = await fetcher.getScores('build_failed', 'cust-1', 'agent-1');
    expect(scores).toHaveLength(2);
    expect(liApi.getScores).toHaveBeenCalledWith('build_failed', 'cust-1', 'agent-1');
  });

  it('caches scores within TTL', async () => {
    await fetcher.getScores('build_failed', 'cust-1', 'agent-1');
    await fetcher.getScores('build_failed', 'cust-1', 'agent-1');
    expect(liApi.getScores).toHaveBeenCalledTimes(1);
  });

  it('uses separate cache keys per customer+task', async () => {
    await fetcher.getScores('build_failed', 'cust-1', 'agent-1');
    await fetcher.getScores('build_failed', 'cust-2', 'agent-1');
    expect(liApi.getScores).toHaveBeenCalledTimes(2);
  });

  it('returns empty array on API failure', async () => {
    const failingApi = {
      getScores: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as LiApiClient;
    const f = new ScoreFetcher(failingApi);
    const scores = await f.getScores('build_failed', 'cust-1', 'agent-1');
    expect(scores).toEqual([]);
  });

  it('returns stale cache on API failure', async () => {
    // First call succeeds
    const scores1 = await fetcher.getScores('build_failed', 'cust-1', 'agent-1');
    expect(scores1).toHaveLength(2);

    // Subsequent calls fail, should return stale
    (liApi.getScores as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Down'));
    const scores2 = await fetcher.getScores('build_failed', 'cust-1', 'agent-1');
    expect(scores2).toHaveLength(2);
  });

  it('reports cache size', async () => {
    expect(fetcher.cacheSize).toBe(0);
    await fetcher.getScores('task_a', 'cust-1', 'agent-1');
    expect(fetcher.cacheSize).toBe(1);
    await fetcher.getScores('task_b', 'cust-1', 'agent-1');
    expect(fetcher.cacheSize).toBe(2);
  });

  it('clearCache empties the cache', async () => {
    await fetcher.getScores('task_a', 'cust-1', 'agent-1');
    fetcher.clearCache();
    expect(fetcher.cacheSize).toBe(0);
  });

  it('warm preloads cache', async () => {
    await fetcher.warm('build_failed', 'cust-1', 'agent-1');
    expect(fetcher.cacheSize).toBe(1);
    // Subsequent getScores should hit cache
    await fetcher.getScores('build_failed', 'cust-1', 'agent-1');
    expect(liApi.getScores).toHaveBeenCalledTimes(1); // Only the warm call
  });

  it('warm is best-effort on failure', async () => {
    const failingApi = {
      getScores: vi.fn().mockRejectedValue(new Error('Down')),
    } as unknown as LiApiClient;
    const f = new ScoreFetcher(failingApi);
    await expect(f.warm('build_failed', 'cust-1', 'agent-1')).resolves.not.toThrow();
    expect(f.cacheSize).toBe(0);
  });
});
