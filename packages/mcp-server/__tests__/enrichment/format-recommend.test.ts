import { describe, it, expect } from 'vitest';
import { formatRecommendEnrichment } from '../../src/enrichment/format-recommend.js';
import type { ScoredAction } from '../../src/types.js';

function makeScore(overrides: Partial<ScoredAction> = {}): ScoredAction {
  return {
    actionName: 'github_push_fix',
    compositeScore: 0.85,
    successRate: 0.92,
    sampleSize: 50,
    ...overrides,
  };
}

describe('formatRecommendEnrichment', () => {
  const desc = 'Push a fix commit to the repository.';

  it('returns original description when score is null', () => {
    const result = formatRecommendEnrichment(desc, 'tool', 'task', null, null);
    expect(result).toBe(desc);
  });

  it('returns original description when sample size is 0', () => {
    const score = makeScore({ sampleSize: 0 });
    const result = formatRecommendEnrichment(desc, 'tool', 'task', score, 1);
    expect(result).toBe(desc);
  });

  it('shows insufficient data for sample < 3', () => {
    const score = makeScore({ sampleSize: 2, successRate: 0.5 });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, null);
    expect(result).toContain('Insufficient historical data');
    expect(result).toContain('github_push');
    expect(result).toContain('build_failed');
    expect(result).toContain('2 recorded outcomes');
  });

  it('shows limited data warning for sample < 10', () => {
    const score = makeScore({ sampleSize: 5, successRate: 0.8 });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, null);
    expect(result).toContain('limited data: 5 outcomes');
    expect(result).toContain('80% of the time');
  });

  it('shows full data for sample >= 10', () => {
    const score = makeScore({ sampleSize: 50, successRate: 0.92 });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('92% of the time');
    expect(result).toContain('50 recorded outcomes');
    expect(result).not.toContain('limited data');
    expect(result).not.toContain('Insufficient');
  });

  it('appends trend when available and sample >= 10', () => {
    const score = makeScore({ sampleSize: 20, successRate: 0.8, trendLabel: 'improving' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('Success rate is improving');
  });

  it('does not append trend for sample < 10', () => {
    const score = makeScore({ sampleSize: 5, successRate: 0.8, trendLabel: 'improving' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).not.toContain('Success rate is');
  });

  it('handles strongly_improving trend', () => {
    const score = makeScore({ sampleSize: 20, successRate: 0.8, trendLabel: 'strongly_improving' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('improving significantly');
  });

  it('handles sharply_declining trend', () => {
    const score = makeScore({ sampleSize: 20, successRate: 0.2, trendLabel: 'sharply_declining' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('declining significantly');
  });

  it('handles stable trend', () => {
    const score = makeScore({ sampleSize: 20, successRate: 0.8, trendLabel: 'stable' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('stable');
  });

  it('handles slightly_improving trend', () => {
    const score = makeScore({ sampleSize: 20, successRate: 0.7, trendLabel: 'slightly_improving' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('slight positive trend');
  });

  it('handles slightly_declining trend', () => {
    const score = makeScore({ sampleSize: 20, successRate: 0.4, trendLabel: 'slightly_declining' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('slight decline');
  });

  it('handles declining trend', () => {
    const score = makeScore({ sampleSize: 20, successRate: 0.3, trendLabel: 'declining' });
    const result = formatRecommendEnrichment(desc, 'github_push', 'build_failed', score, 1);
    expect(result).toContain('declining');
  });
});
