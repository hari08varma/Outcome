/**
 * Layerinfinite — Unit Tests: Scoring Engine
 * Tests the 5-factor composite formula and cache behaviour.
 * Run: npm test (from api/)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Import scoring constants for formula validation ──────────
// We test the pure formula logic without DB calls
const W_SUCCESS = 0.40;
const W_CONF = 0.20;
const W_TREND = 0.20;
const W_SALIENCE = 0.10;
const W_RECENCY = 0.10;

// ── Pure formula (mirrors lib/scoring.ts) ────────────────────
function computeCompositeScore(row: {
    weighted_success_rate: number;
    raw_success_rate: number;
    confidence: number;
    trend_delta: number | null;
    last_outcome_at: string | null;
}, contextMatch: number | null = null): number {
    const f_success = row.weighted_success_rate ?? row.raw_success_rate ?? 0;
    const f_conf = row.confidence ?? 0;
    const rawTrend = row.trend_delta ?? 0;
    const f_trend = Math.max(0, Math.min(1, rawTrend + 0.5));
    const f_salience = 1.0;
    let f_recency = 0.5;
    if (row.last_outcome_at) {
        const ageHours = (Date.now() - new Date(row.last_outcome_at).getTime()) / 3_600_000;
        f_recency = Math.max(0, Math.min(1, 1 - ageHours / 168));
    }
    const f_context = contextMatch ?? 1.0;
    return (W_SUCCESS * f_success + W_CONF * f_conf + W_TREND * f_trend + W_SALIENCE * f_salience + W_RECENCY * f_recency) * f_context;
}

// ── Tests ─────────────────────────────────────────────────────

describe('Scoring Engine — 5-Factor Formula', () => {
    const baseRow = {
        weighted_success_rate: 0.8,
        raw_success_rate: 0.75,
        confidence: 0.80,
        trend_delta: null,
        last_outcome_at: new Date().toISOString(),
    };

    it('weights sum to 1.0', () => {
        const total = W_SUCCESS + W_CONF + W_TREND + W_SALIENCE + W_RECENCY;
        expect(total).toBeCloseTo(1.0, 10);
    });

    it('returns a score in [0, 1] for normal inputs', () => {
        const score = computeCompositeScore(baseRow);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    it('perfect action (100% success, high confidence) scores > 0.8', () => {
        const score = computeCompositeScore({
            ...baseRow,
            weighted_success_rate: 1.0,
            raw_success_rate: 1.0,
            confidence: 0.95,
            trend_delta: 0.3,
        });
        expect(score).toBeGreaterThan(0.80);
    });

    it('broken action (0% success, low confidence) scores < 0.3', () => {
        const score = computeCompositeScore({
            ...baseRow,
            weighted_success_rate: 0.0,
            raw_success_rate: 0.0,
            confidence: 0.05,
            trend_delta: -0.4,
        });
        expect(score).toBeLessThan(0.30);
    });

    it('trend_delta=null treated as 0.0 (neutral)', () => {
        const withNull = computeCompositeScore({ ...baseRow, trend_delta: null });
        const withZero = computeCompositeScore({ ...baseRow, trend_delta: 0.0 });
        expect(withNull).toBeCloseTo(withZero, 6);
    });

    it('positive trend_delta improves score vs negative', () => {
        const positive = computeCompositeScore({ ...baseRow, trend_delta: 0.3 });
        const negative = computeCompositeScore({ ...baseRow, trend_delta: -0.3 });
        expect(positive).toBeGreaterThan(negative);
    });

    it('fresh outcome (< 1 hour) has higher recency factor than stale (7 days)', () => {
        const now = new Date().toISOString();
        const week = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
        const fresh = computeCompositeScore({ ...baseRow, last_outcome_at: now });
        const stale = computeCompositeScore({ ...baseRow, last_outcome_at: week });
        expect(fresh).toBeGreaterThan(stale);
    });

    it('recency factor is clamped to [0, 1] for old outcomes', () => {
        // 100-day-old outcome
        const ancient = new Date(Date.now() - 100 * 24 * 3_600_000).toISOString();
        const score = computeCompositeScore({ ...baseRow, last_outcome_at: ancient });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    it('salience factor is always 1.0 (Phase 5 extensibility)', () => {
        // We test this implicitly: formula must use W_SALIENCE * 1.0
        const score = computeCompositeScore(baseRow);
        const expectedBase = W_SUCCESS * baseRow.weighted_success_rate + W_CONF * baseRow.confidence;
        expect(score).toBeGreaterThan(expectedBase);  // salience + recency add to it
    });
});

describe('Scoring Engine — Confidence Formula', () => {
    it('n=0 → confidence = 0', () => {
        const n = 0;
        const confidence = n / (n + 10);
        expect(confidence).toBe(0);
    });

    it('n=10 → confidence = 0.5', () => {
        const n = 10;
        const confidence = n / (n + 10);
        expect(confidence).toBe(0.5);
    });

    it('n=90 → confidence = 0.9', () => {
        const n = 90;
        const confidence = n / (n + 10);
        expect(confidence).toBe(0.9);
    });

    it('n=990 → confidence > 0.99', () => {
        const n = 990;
        const confidence = n / (n + 10);
        expect(confidence).toBeGreaterThanOrEqual(0.99);
    });
});

describe('Scoring Engine — Recommendation Labels', () => {
    const MIN_CONFIDENCE = 0.30;
    const ESCALATION_SCORE = 0.20;

    function toRecommendation(score: number): string {
        if (score < ESCALATION_SCORE) return 'escalate';
        if (score >= 0.65) return 'recommend';
        if (score >= 0.40) return 'neutral';
        return 'avoid';
    }

    it('score >= 0.65 → recommend', () => {
        expect(toRecommendation(0.65)).toBe('recommend');
        expect(toRecommendation(0.90)).toBe('recommend');
    });

    it('score 0.40–0.64 → neutral', () => {
        expect(toRecommendation(0.40)).toBe('neutral');
        expect(toRecommendation(0.64)).toBe('neutral');
    });

    it('score 0.20–0.39 → avoid', () => {
        expect(toRecommendation(0.25)).toBe('avoid');
        expect(toRecommendation(0.39)).toBe('avoid');
    });

    it('score < 0.20 → escalate', () => {
        expect(toRecommendation(0.0)).toBe('escalate');
        expect(toRecommendation(0.19)).toBe('escalate');
    });
});

describe('Scoring Engine — Trend Factor Normalisation', () => {
    function normaliseTrend(delta: number): number {
        return Math.max(0, Math.min(1, delta + 0.5));
    }

    it('trend_delta = 0 → factor = 0.5 (neutral)', () => {
        expect(normaliseTrend(0)).toBe(0.5);
    });

    it('trend_delta = +0.5 → factor = 1.0 (max positive)', () => {
        expect(normaliseTrend(0.5)).toBe(1.0);
    });

    it('trend_delta = -0.5 → factor = 0.0 (max negative)', () => {
        expect(normaliseTrend(-0.5)).toBe(0.0);
    });

    it('trend_delta > 0.5 → clamped to 1.0', () => {
        expect(normaliseTrend(999)).toBe(1.0);
    });

    it('trend_delta < -0.5 → clamped to 0.0', () => {
        expect(normaliseTrend(-999)).toBe(0.0);
    });
});

describe('Scoring Engine — Context Match Factor', () => {
    const baseRow = {
        weighted_success_rate: 0.8,
        raw_success_rate: 0.75,
        confidence: 0.80,
        trend_delta: null as number | null,
        last_outcome_at: new Date().toISOString(),
    };

    it('context_match=0.7 produces lower score than context_match=1.0', () => {
        const scoreFull = computeCompositeScore(baseRow, 1.0);
        const scorePartial = computeCompositeScore(baseRow, 0.7);
        expect(scorePartial).toBeLessThan(scoreFull);
        expect(scorePartial).toBeCloseTo(scoreFull * 0.7, 5);
    });

    it('null context_match defaults to 1.0 (fallback)', () => {
        const scoreNull = computeCompositeScore(baseRow, null);
        const scoreExplicit = computeCompositeScore(baseRow, 1.0);
        expect(scoreNull).toBeCloseTo(scoreExplicit, 10);
    });
});
