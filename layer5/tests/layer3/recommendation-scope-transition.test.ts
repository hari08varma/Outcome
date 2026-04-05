import { describe, expect, it } from 'vitest';

import type { ScopeTransitionCandidate } from '../../api/lib/recommendation/scope-transition.js';
import {
    chooseScopedOrBlendedCandidate,
    getSampleThresholdProgress,
} from '../../api/lib/recommendation/scope-transition.js';

function makeCandidate(
    overrides: Partial<ScopeTransitionCandidate>,
): ScopeTransitionCandidate {
    return {
        state: 'early_signal',
        min_sample_count: 10,
        confidence: 0.3,
        has_best_action: true,
        ...overrides,
    };
}

describe('chooseScopedOrBlendedCandidate', () => {
    it('keeps agent-scoped recommendation when scoped evidence is mature', () => {
        const scoped = makeCandidate({
            state: 'stable',
            confidence: 0.62,
            min_sample_count: 24,
        });

        const blended = makeCandidate({
            state: 'stable',
            confidence: 0.91,
            min_sample_count: 68,
        });

        const choice = chooseScopedOrBlendedCandidate(scoped, blended);

        expect(choice.servedScope).toBe('agent_scoped');
        expect(choice.reason).toBeNull();
        expect(choice.threshold_progress.bucket).toBe('transition');
    });

    it('falls back to blended cohort when scoped evidence is weak and blended is clearly stronger', () => {
        const scoped = makeCandidate({
            state: 'early_signal',
            confidence: 0.16,
            min_sample_count: 6,
        });

        const blended = makeCandidate({
            state: 'stable',
            confidence: 0.58,
            min_sample_count: 26,
        });

        const choice = chooseScopedOrBlendedCandidate(scoped, blended);

        expect(choice.servedScope).toBe('customer_blended');
        expect(choice.reason).toContain('blended cohort evidence');
        expect(choice.threshold_progress.bucket).toBe('warmup');
    });

    it('keeps agent-scoped result when blended cohort cannot meet minimum reliability gates', () => {
        const scoped = makeCandidate({
            state: 'early_signal',
            confidence: 0.22,
            min_sample_count: 8,
        });

        const blended = makeCandidate({
            state: 'no_data',
            confidence: null,
            min_sample_count: 4,
            has_best_action: false,
        });

        const choice = chooseScopedOrBlendedCandidate(scoped, blended);

        expect(choice.servedScope).toBe('agent_scoped');
        expect(choice.reason).toContain('did not pass minimum reliability gates');
        expect(choice.threshold_progress.bucket).toBe('warmup');
    });

    it('keeps agent-scoped result when blended evidence is only marginally better', () => {
        const scoped = makeCandidate({
            state: 'early_signal',
            confidence: 0.35,
            min_sample_count: 12,
        });

        const blended = makeCandidate({
            state: 'early_signal',
            confidence: 0.36,
            min_sample_count: 14,
        });

        const choice = chooseScopedOrBlendedCandidate(scoped, blended);

        expect(choice.servedScope).toBe('agent_scoped');
        expect(choice.reason).toContain('not meaningfully stronger');
        expect(choice.threshold_progress.bucket).toBe('transition');
    });
});

describe('getSampleThresholdProgress', () => {
    it.each([
        { samples: 9, bucket: 'warmup', next: 10, remaining: 1 },
        { samples: 10, bucket: 'transition', next: 50, remaining: 40 },
        { samples: 49, bucket: 'transition', next: 50, remaining: 1 },
        { samples: 50, bucket: 'stable', next: 100, remaining: 50 },
        { samples: 99, bucket: 'stable', next: 100, remaining: 1 },
        { samples: 100, bucket: 'cohort_anchor', next: null, remaining: 0 },
    ])('maps $samples samples to $bucket bucket', ({ samples, bucket, next, remaining }) => {
        const progress = getSampleThresholdProgress(samples);

        expect(progress.bucket).toBe(bucket);
        expect(progress.current_samples).toBe(samples);
        expect(progress.next_threshold).toBe(next);
        expect(progress.remaining_to_next_bucket).toBe(remaining);
    });
});
