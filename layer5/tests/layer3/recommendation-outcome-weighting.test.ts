import { describe, expect, it } from 'vitest';

import {
    LOW_QUALITY_HARD_EXCLUSION_DAYS,
    MEDIUM_QUALITY_HALF_LIFE_DAYS,
    classifyOutcomeQuality,
    computeOutcomeEffectiveWeightForScore,
} from '../../api/lib/recommendation/outcome-weighting.js';

const NOW_MS = Date.parse('2026-04-05T12:00:00.000Z');

function isoDaysAgo(days: number): string {
    const ms = NOW_MS - days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
}

describe('recommendation outcome weighting', () => {
    it('classifies quality buckets by outcome score', () => {
        expect(classifyOutcomeQuality(0.9)).toBe('high');
        expect(classifyOutcomeQuality(0.8)).toBe('high');
        expect(classifyOutcomeQuality(0.79)).toBe('medium');
        expect(classifyOutcomeQuality(0.5)).toBe('medium');
        expect(classifyOutcomeQuality(0.49)).toBe('low');
    });

    it('uses full weight at day 0 for high quality outcomes', () => {
        const weight = computeOutcomeEffectiveWeightForScore(
            0.95,
            isoDaysAgo(0),
            NOW_MS,
        );

        expect(weight).toBeCloseTo(1.0, 6);
    });

    it('applies medium-quality damping at 14 days using configured half-life', () => {
        const expected = 0.6 * Math.exp(-Math.LN2 * 14 / MEDIUM_QUALITY_HALF_LIFE_DAYS);

        const weight = computeOutcomeEffectiveWeightForScore(
            0.6,
            isoDaysAgo(14),
            NOW_MS,
        );

        expect(weight).toBeCloseTo(expected, 6);
    });

    it('keeps low-quality outcomes at 30 days with damped non-zero weight', () => {
        const weight = computeOutcomeEffectiveWeightForScore(
            0.1,
            isoDaysAgo(30),
            NOW_MS,
        );

        expect(weight).toBeGreaterThan(0);
        expect(weight).toBeLessThan(0.25);
    });

    it('hard-excludes low-quality outcomes older than 30 days', () => {
        const weight = computeOutcomeEffectiveWeightForScore(
            0.1,
            isoDaysAgo(LOW_QUALITY_HARD_EXCLUSION_DAYS + 1),
            NOW_MS,
        );

        expect(weight).toBe(0);
    });

    it('decays high-quality outcomes to ~0.5 weight around 90 days', () => {
        const weight = computeOutcomeEffectiveWeightForScore(
            0.95,
            isoDaysAgo(90),
            NOW_MS,
        );

        expect(weight).toBeCloseTo(0.5, 5);
    });
});
