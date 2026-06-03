import { describe, it, expect } from 'vitest';
import { formatAssistEnrichment } from '../../src/enrichment/format-assist.js';
import type { AssistFormatContext } from '../../src/enrichment/format-assist.js';
import type { ScoredAction } from '../../src/types.js';

function makeScore(overrides: Partial<ScoredAction> = {}): ScoredAction {
  return {
    actionName: 'github_push_fix',
    compositeScore: 85,
    successRate: 0.92,
    sampleSize: 50,
    ...overrides,
  };
}

function makeContext(overrides: Partial<AssistFormatContext> = {}): AssistFormatContext {
  return {
    toolName: 'github_push_fix',
    taskType: 'build_failed',
    description: 'Push a fix commit.',
    score: makeScore(),
    rank: 1,
    totalTools: 5,
    bestScore: makeScore(),
    ...overrides,
  };
}

describe('formatAssistEnrichment', () => {
  it('returns no-data message when score is null', () => {
    const ctx = makeContext({ score: null });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('No historical data available');
    expect(result).toContain('build_failed');
  });

  it('returns no-data message when sample size is 0', () => {
    const ctx = makeContext({ score: makeScore({ sampleSize: 0 }) });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('No historical data available');
  });

  it('includes historical context', () => {
    const ctx = makeContext();
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('92% success rate');
    expect(result).toContain('50 executions');
  });

  it('shows insufficient data for sample < 3', () => {
    const ctx = makeContext({ score: makeScore({ sampleSize: 2 }) });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('insufficient data for reliability');
    expect(result).toContain('been used 2 times');
  });

  it('shows recommended badge for rank 1', () => {
    const ctx = makeContext({ rank: 1 });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('recommended tool for this task');
  });

  it('shows tied-for-best when close to top ranker', () => {
    const bestScore = makeScore({ actionName: 'other_tool', successRate: 0.94 });
    const ctx = makeContext({
      rank: 2,
      score: makeScore({ successRate: 0.92, actionName: 'my_tool' }),
      bestScore,
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('Tied for best option');
    expect(result).toContain('other_tool');
  });

  it('shows rank when not first and not tied', () => {
    const bestScore = makeScore({ actionName: 'best_tool', successRate: 0.95 });
    const ctx = makeContext({
      rank: 3,
      score: makeScore({ successRate: 0.50, actionName: 'my_tool' }),
      bestScore,
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('Ranked #3 of 5');
  });

  it('shows critical warning for success < 30% with enough data', () => {
    const ctx = makeContext({
      rank: 4,
      score: makeScore({ successRate: 0.25, sampleSize: 10 }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('WARNING');
    expect(result).toContain('critically low');
  });

  it('shows caution for success < 50%', () => {
    const ctx = makeContext({
      rank: 3,
      score: makeScore({ successRate: 0.40, sampleSize: 10 }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('CAUTION');
    expect(result).toContain('fails more than half the time');
  });

  it('no warning when sample size < 5', () => {
    const ctx = makeContext({
      score: makeScore({ successRate: 0.20, sampleSize: 4 }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).not.toContain('WARNING');
    expect(result).not.toContain('CAUTION');
  });

  it('does not show ranking guidance for sample < 3', () => {
    const ctx = makeContext({
      rank: 1,
      score: makeScore({ successRate: 0.90, sampleSize: 2 }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).not.toContain('recommended tool for this task');
    expect(result).not.toContain('Ranked');
  });

  it('includes trend information inline', () => {
    const ctx = makeContext({
      score: makeScore({ sampleSize: 20, trendLabel: 'strongly_improving' }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('improving significantly');
  });

  it('omits trend text for stable', () => {
    const ctx = makeContext({
      score: makeScore({ sampleSize: 20, trendLabel: 'stable' }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).not.toContain('stable');
  });

  it('shows alternative count in caution message', () => {
    const ctx = makeContext({
      rank: 3,
      totalTools: 4,
      score: makeScore({ successRate: 0.35, sampleSize: 10 }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('3 alternatives available');
  });

  it('handles single alternative correctly', () => {
    const ctx = makeContext({
      rank: 2,
      totalTools: 2,
      score: makeScore({ successRate: 0.35, sampleSize: 10 }),
    });
    const result = formatAssistEnrichment(ctx);
    expect(result).toContain('1 alternative available');
  });
});
