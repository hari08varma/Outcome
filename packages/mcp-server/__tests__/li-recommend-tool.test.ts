import { describe, it, expect } from 'vitest';
import { createLiRecommendTool, handleLiRecommend } from '../src/li-recommend-tool.js';
import type { LiApiClient } from '../src/rest-client.js';
import type { ScoredAction } from '../src/types.js';

function mockLiApi(scores: ScoredAction[] = []): LiApiClient {
  return {
    getScores: async () => scores,
  } as unknown as LiApiClient;
}

function makeScore(overrides: Partial<ScoredAction> = {}): ScoredAction {
  return {
    actionName: 'github_push',
    compositeScore: 0.90,
    successRate: 0.85,
    sampleSize: 100,
    ...overrides,
  };
}

describe('createLiRecommendTool', () => {
  it('creates tool with li_recommend name', () => {
    const tool = createLiRecommendTool();
    expect(tool.name).toBe('li_recommend');
  });

  it('has ranking 0 (always first)', () => {
    const tool = createLiRecommendTool();
    expect(tool.annotations?.ranking).toBe(0);
    expect(tool.annotations?.category).toBe('recommended');
  });

  it('has upstreamName layerinfinite', () => {
    expect(createLiRecommendTool().upstreamName).toBe('layerinfinite');
  });

  it('includes inputSchema with required task param', () => {
    const tool = createLiRecommendTool();
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, unknown>;
    expect(props.task).toBeDefined();
    const required = schema.required as string[];
    expect(required).toContain('task');
  });
});

describe('handleLiRecommend', () => {
  it('returns no-data message when scores empty', async () => {
    const api = mockLiApi([]);
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    expect(result.content[0].text).toContain('No recommendations available yet');
  });

  it('returns ranked recommendations when scores exist', async () => {
    const scores = [
      makeScore({ actionName: 'tool_a', successRate: 0.95, sampleSize: 50 }),
      makeScore({ actionName: 'tool_b', successRate: 0.80, sampleSize: 30 }),
    ];
    const api = mockLiApi(scores);
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    expect(result.content[0].text).toContain('tool_a');
    expect(result.content[0].text).toContain('95% success');
    expect(result.content[0].text).toContain('tool_b');
  });

  it('limits to top 5', async () => {
    const scores = Array.from({ length: 10 }, (_, i) =>
      makeScore({ actionName: `tool_${i}`, compositeScore: 1 - i * 0.1, sampleSize: 30 }),
    );
    const api = mockLiApi(scores);
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    const text = result.content[0].text;
    // Count numbered items (1. to 5.)
    const matches = text.match(/^\d+\./gm);
    expect(matches).toHaveLength(5);
  });

  it('shows warning for below-threshold success', async () => {
    const scores = [makeScore({ actionName: 'risky_tool', successRate: 0.30, sampleSize: 50 })];
    const api = mockLiApi(scores);
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    expect(result.content[0].text).toContain('BELOW THRESHOLD');
  });

  it('no warning when sample < 5 even with low success', async () => {
    const scores = [makeScore({ actionName: 'risky_tool', successRate: 0.20, sampleSize: 3 })];
    const api = mockLiApi(scores);
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    expect(result.content[0].text).not.toContain('BELOW THRESHOLD');
  });

  it('shows trend arrows', async () => {
    const scores = [
      makeScore({ actionName: 'improving', sampleSize: 50, trendLabel: 'improving' }),
      makeScore({ actionName: 'declining', sampleSize: 50, trendLabel: 'declining' }),
    ];
    const api = mockLiApi(scores);
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    const text = result.content[0].text;
    expect(text).toContain('↑');
    expect(text).toContain('↓');
  });

  it('returns error on API failure', async () => {
    const api: LiApiClient = {
      getScores: async () => { throw new Error('API down'); },
    } as unknown as LiApiClient;
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unable to fetch recommendations');
  });

  it('shows single-tool message when only one result', async () => {
    const scores = [makeScore({ sampleSize: 50 })];
    const api = mockLiApi(scores);
    const result = await handleLiRecommend(api, 'build_failed', 'cust-1', 'agent-1');
    expect(result.content[0].text).toContain('only tool with outcome history');
  });
});
