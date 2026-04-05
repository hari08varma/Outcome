import { describe, expect, it } from 'vitest';

import type { ScopeTransitionCandidate } from '../../api/lib/recommendation/scope-transition.js';
import { chooseScopedOrBlendedCandidate } from '../../api/lib/recommendation/scope-transition.js';

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
    });
});
