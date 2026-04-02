// TODO: observe.test.ts — pending fix of /observe route.
// The route is currently broken (missing context_id resolution).
// See: https://github.com/hari08varma/Outcome/issues/[issue number]
// Add end-to-end test once fixed.

import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
    },
}));

import {
    computeCompositeScore,
    PRIOR_ALPHA,
    PRIOR_BETA,
    W_SUCCESS,
    W_CONF,
    W_TREND,
    W_SALIENCE,
    W_RECENCY,
    MIN_CONFIDENCE,
} from '../lib/scoring.js';
import type { ActionScore } from '../lib/supabase.js';

type TestActionScore = ActionScore & {
    weighted_success_rate: number | null;
    raw_success_rate: number | null;
    avg_salience_score: number | null;
    last_outcome_at: string | null;
};

function makeRow(overrides: Partial<TestActionScore> = {}): TestActionScore {
    return {
        action_id: 'a1',
        context_id: 'ctx-1',
        customer_id: 'cust-1',
        action_name: 'refund',
        action_category: 'billing',
        raw_success_rate: 0.8,
        weighted_success_rate: 0.8,
        confidence: 0.85,
        total_attempts: 25,
        total_successes: 20,
        total_failures: 5,
        trend_delta: 0,
        business_hours_rate: null,
        after_hours_rate: null,
        last_outcome_at: new Date().toISOString(),
        view_refreshed_at: new Date().toISOString(),
        avg_salience_score: 1.0,
        ...overrides,
    };
}

describe('computeCompositeScore', () => {
    it('triple-null cold start: last_outcome_at=null, avg_salience_score=null, total_attempts=0', () => {
        const row = makeRow({
            last_outcome_at: null,
            avg_salience_score: null,
            total_attempts: 0,
            weighted_success_rate: 0,
            raw_success_rate: 0,
            confidence: 0,
            trend_delta: null,
        });

        const score = computeCompositeScore(row as ActionScore);

        expect(typeof score).toBe('number');
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);

        const expectedSuccess = (0 * 0 + PRIOR_ALPHA) / (0 + PRIOR_ALPHA + PRIOR_BETA);
        const expected =
            W_SUCCESS * expectedSuccess +
            W_CONF * 0 +
            W_TREND * 0.5 +
            W_SALIENCE * 1.0 +
            W_RECENCY * 0.5;

        expect(Math.abs(score - expected)).toBeLessThan(0.001);
        expect(Math.abs(score - 0.45)).toBeLessThan(0.001);
        expect(MIN_CONFIDENCE).toBe(0.3);
    });

    it('normal well-performing action: 25 attempts, 0.85 success, 0.9 conf', () => {
        const row = makeRow({
            weighted_success_rate: 0.85,
            total_attempts: 25,
            confidence: 0.9,
            trend_delta: 0.1,
        });

        const score = computeCompositeScore(row as ActionScore);

        expect(score).toBeGreaterThan(0.7);
        expect(score).toBeLessThanOrEqual(1.0);
    });

    it('IPS blend: total_attempts=5 (< 20), ipsSignal=0.8', () => {
        const row = makeRow({ total_attempts: 5, confidence: 0.3 });

        const withIPS = computeCompositeScore(row as ActionScore, null, 0.8);
        const withoutIPS = computeCompositeScore(row as ActionScore, null, null);

        expect(withIPS).not.toBe(withoutIPS);
        expect(withIPS).toBeGreaterThan(withoutIPS);

        const blendWeight = Math.min(0.10, ((20 - 5) / 20) * 0.10);
        const expected = withoutIPS * (1 - blendWeight) + 0.8 * blendWeight;
        expect(Math.abs(withIPS - expected)).toBeLessThan(0.005);
    });

    it('IPS not applied when total_attempts >= 20', () => {
        const row = makeRow({ total_attempts: 20, confidence: 0.6 });

        const withIPS = computeCompositeScore(row as ActionScore, null, 0.9);
        const withoutIPS = computeCompositeScore(row as ActionScore, null, null);

        expect(withIPS).toBe(withoutIPS);
    });

    it('context match reduces score proportionally', () => {
        const row = makeRow({ total_attempts: 30, confidence: 0.8, weighted_success_rate: 0.9 });

        const fullMatch = computeCompositeScore(row as ActionScore, 1.0, null);
        const halfMatch = computeCompositeScore(row as ActionScore, 0.5, null);

        expect(Math.abs(halfMatch - fullMatch * 0.5)).toBeLessThan(0.001);
    });

    it('output always clamped to [0, 1]', () => {
        const edgeCases: TestActionScore[] = [
            makeRow({
                weighted_success_rate: 0,
                total_attempts: 0,
                confidence: 0,
                trend_delta: -1.0,
                avg_salience_score: 0,
                last_outcome_at: null,
            }),
            makeRow({
                weighted_success_rate: 1,
                total_attempts: 100,
                confidence: 1,
                trend_delta: 1.0,
                avg_salience_score: 1,
            }),
        ];

        for (const row of edgeCases) {
            const score = computeCompositeScore(row as ActionScore);
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(1);
        }
    });

    it('negative trend_delta: degrading action scores lower than stable', () => {
        const stable = computeCompositeScore(makeRow({ trend_delta: 0 }) as ActionScore);
        const degrading = computeCompositeScore(makeRow({ trend_delta: -0.3 }) as ActionScore);

        expect(degrading).toBeLessThan(stable);
    });

    it('recency decay: action with last_outcome_at 6 days ago scores lower than action with last_outcome_at 1 hour ago', () => {
        const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
        const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

        const recent = computeCompositeScore(makeRow({ last_outcome_at: oneHourAgo }) as ActionScore);
        const stale = computeCompositeScore(makeRow({ last_outcome_at: sixDaysAgo }) as ActionScore);

        expect(recent).toBeGreaterThan(stale);
    });
});
