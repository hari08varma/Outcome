import { describe, it, expect } from 'vitest';
import { enrichToolList } from '../src/tool-enrichment.js';
import type { EnrichmentContext, ScoredAction } from '../src/types.js';
import type { RawUpstreamTool } from '../src/rest-client.js';

function makeScores(): ScoredAction[] {
  return [
    { actionName: 'github_push', compositeScore: 0.95, successRate: 0.90, sampleSize: 100, trendLabel: 'improving' },
    { actionName: 'database_query', compositeScore: 0.60, successRate: 0.55, sampleSize: 50, trendLabel: 'stable' },
    { actionName: 'web_search', compositeScore: 0.30, successRate: 0.25, sampleSize: 10, trendLabel: 'declining' },
    { actionName: 'file_edit', compositeScore: 0.10, successRate: 0.10, sampleSize: 2 },
  ];
}

function makeTools(): RawUpstreamTool[] {
  return [
    { name: 'github_push', description: 'Push commits', inputSchema: { type: 'object' }, upstreamName: 'github' },
    { name: 'database_query', description: 'Query DB', inputSchema: { type: 'object' }, upstreamName: 'database' },
    { name: 'web_search', description: 'Search web', inputSchema: { type: 'object' }, upstreamName: 'web' },
    { name: 'file_edit', description: 'Edit files', inputSchema: { type: 'object' }, upstreamName: 'filesystem' },
  ];
}

function makeContext(overrides: Partial<EnrichmentContext> = {}): EnrichmentContext {
  return {
    taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1',
    mode: 'recommend', scores: makeScores(), policyDecision: null,
    ...overrides,
  };
}

describe('enrichToolList', () => {
  it('enriches tools with historical scores in recommend mode', () => {
    const tools = makeTools();
    const enriched = enrichToolList(tools, makeContext({ mode: 'recommend' }));
    expect(enriched).toHaveLength(4);
    expect(enriched[0].description).toContain('90% of the time');
  });

  it('preserves inputSchema unchanged', () => {
    const tools = makeTools();
    const enriched = enrichToolList(tools, makeContext());
    for (let i = 0; i < tools.length; i++) {
      expect(enriched[i].inputSchema).toEqual(tools[i].inputSchema);
    }
  });

  it('adds ranking annotations', () => {
    const enriched = enrichToolList(makeTools(), makeContext());
    expect(enriched[0].annotations?.ranking).toBe(1);
    expect(enriched[1].annotations?.ranking).toBe(2);
  });

  it('categorizes high scores as recommended', () => {
    const enriched = enrichToolList(makeTools(), makeContext());
    expect(enriched[0].annotations?.category).toBe('recommended');
  });

  it('categorizes medium scores as neutral', () => {
    const enriched = enrichToolList(makeTools(), makeContext());
    expect(enriched[1].annotations?.category).toBe('neutral');
  });

  it('categorizes low scores as warning', () => {
    const enriched = enrichToolList(makeTools(), makeContext());
    expect(enriched[2].annotations?.category).toBe('warning');
  });

  it('does not categorize tools with < 3 samples', () => {
    const enriched = enrichToolList(makeTools(), makeContext());
    expect(enriched[3].annotations?.category).toBeUndefined();
  });

  it('returns unchanged descriptions in bootstrap mode', () => {
    const tools = makeTools();
    const enriched = enrichToolList(tools, makeContext({ mode: 'bootstrap' }));
    for (let i = 0; i < tools.length; i++) {
      expect(enriched[i].description).toBe(tools[i].description);
    }
  });

  it('returns unchanged descriptions in auto mode', () => {
    const tools = makeTools();
    const enriched = enrichToolList(tools, makeContext({ mode: 'auto' }));
    for (let i = 0; i < tools.length; i++) {
      expect(enriched[i].description).toBe(tools[i].description);
    }
  });

  it('uses assist format in assist mode', () => {
    const enriched = enrichToolList(makeTools(), makeContext({ mode: 'assist' }));
    expect(enriched[0].description).toContain('recommended tool for this task');
  });

  it('handles empty scores gracefully', () => {
    const tools = makeTools();
    const enriched = enrichToolList(tools, makeContext({ scores: [] }));
    expect(enriched).toHaveLength(4);
    expect(enriched[0].annotations?.ranking).toBeUndefined();
  });

  it('handles empty tools list', () => {
    const enriched = enrichToolList([], makeContext());
    expect(enriched).toHaveLength(0);
  });
});
