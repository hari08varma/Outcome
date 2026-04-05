import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildRecommendationDataFreshness,
    RECOMMENDATION_STALE_THRESHOLD_HOURS,
} from '../../api/lib/recommendation/data-freshness.js';

describe('buildRecommendationDataFreshness', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('marks recent data as fresh', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));

        const freshness = buildRecommendationDataFreshness(
            'mv',
            '2026-01-01T10:00:00.000Z',
        );

        expect(freshness.is_stale).toBe(false);
        expect(freshness.age_hours).toBe(2);
        expect(freshness.stale_threshold_hours).toBe(RECOMMENDATION_STALE_THRESHOLD_HOURS);
    });

    it('marks old data as stale', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-05T00:00:00.000Z'));

        const freshness = buildRecommendationDataFreshness(
            'fact_fallback',
            '2025-12-31T00:00:00.000Z',
            72,
        );

        expect(freshness.is_stale).toBe(true);
        expect(freshness.age_hours).toBeGreaterThan(72);
    });

    it('returns non-stale when timestamp is invalid or missing', () => {
        const invalid = buildRecommendationDataFreshness('unknown', 'not-a-date');
        expect(invalid.age_hours).toBeNull();
        expect(invalid.is_stale).toBe(false);

        const missing = buildRecommendationDataFreshness('unknown', null);
        expect(missing.age_hours).toBeNull();
        expect(missing.is_stale).toBe(false);
    });
});