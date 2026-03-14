/**
 * Layerinfinite — Unit Tests: Temporal Memory & Trend Detection (Phase 4)
 * Tests trend delta calculation, trend labels, degradation alerting
 * logic, and score flip (contradiction) detection.
 *
 * Run: npx vitest run tests/layer4/trend.test.ts
 */

import { describe, it, expect } from 'vitest';

// ── Trend label logic (mirrors lib/scoring.ts trendLabel) ────
type TrendLabel = 'stable' | 'improving' | 'degrading' | 'critical';

function trendLabel(trendDelta: number | null): TrendLabel {
    if (trendDelta === null) return 'stable';
    if (trendDelta < -0.15) return 'critical';
    if (trendDelta < -0.05) return 'degrading';
    if (trendDelta > 0.05) return 'improving';
    return 'stable';
}

// ── Degradation detection logic (mirrors trend-detector) ─────
const DEGRADATION_THRESHOLD = -0.15;
const SCORE_FLIP_THRESHOLD = 0.4;

interface ActionTrend {
    action_id: string;
    context_id: string;
    customer_id: string;
    action_name: string;
    trend_delta: number | null;
    raw_success_rate: number;
    weighted_success_rate: number;
    total_attempts: number;
}

function detectDegradation(scores: ActionTrend[]): ActionTrend[] {
    return scores.filter(s =>
        s.trend_delta !== null && s.trend_delta < DEGRADATION_THRESHOLD
    );
}

function detectScoreFlips(scores: ActionTrend[]): Array<{
    action_id: string;
    old_success_rate: number;
    new_success_rate: number;
    score_flip_magnitude: number;
}> {
    return scores
        .filter(s => s.trend_delta !== null && Math.abs(s.trend_delta!) >= SCORE_FLIP_THRESHOLD)
        .map(s => {
            const currentRate = s.weighted_success_rate ?? s.raw_success_rate ?? 0;
            const previousRate = currentRate - (s.trend_delta ?? 0);
            return {
                action_id: s.action_id,
                old_success_rate: Math.max(0, Math.min(1, previousRate)),
                new_success_rate: currentRate,
                score_flip_magnitude: Math.round(Math.abs(s.trend_delta!) * 10000) / 10000,
            };
        });
}

// ── Week-over-week trend delta calculation logic ─────────────
function computeTrendDelta(
    outcomes: Array<{ timestamp: Date; success: boolean }>,
    now: Date = new Date()
): number | null {
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const thisWeek = outcomes.filter(o => o.timestamp >= oneWeekAgo && o.timestamp <= now);
    const lastWeek = outcomes.filter(o => o.timestamp >= twoWeeksAgo && o.timestamp < oneWeekAgo);

    if (thisWeek.length === 0 || lastWeek.length === 0) return null;

    const thisWeekRate = thisWeek.filter(o => o.success).length / thisWeek.length;
    const lastWeekRate = lastWeek.filter(o => o.success).length / lastWeek.length;

    return Math.round((thisWeekRate - lastWeekRate) * 10000) / 10000;
}

// ── Business hours detection ─────────────────────────────────
function isBusinessHours(timestamp: Date): boolean {
    const hourUTC = timestamp.getUTCHours();
    return hourUTC >= 9 && hourUTC <= 17;
}

function computeTimeOfDayRates(
    outcomes: Array<{ timestamp: Date; success: boolean }>
): { businessHoursRate: number | null; afterHoursRate: number | null } {
    const business = outcomes.filter(o => isBusinessHours(o.timestamp));
    const afterHours = outcomes.filter(o => !isBusinessHours(o.timestamp));

    return {
        businessHoursRate: business.length > 0
            ? business.filter(o => o.success).length / business.length
            : null,
        afterHoursRate: afterHours.length > 0
            ? afterHours.filter(o => o.success).length / afterHours.length
            : null,
    };
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

describe('Trend Labels', () => {
    it('null trend_delta → stable', () => {
        expect(trendLabel(null)).toBe('stable');
    });

    it('|trend_delta| < 0.05 → stable', () => {
        expect(trendLabel(0.0)).toBe('stable');
        expect(trendLabel(0.04)).toBe('stable');
        expect(trendLabel(-0.04)).toBe('stable');
    });

    it('trend_delta > +0.05 → improving', () => {
        expect(trendLabel(0.06)).toBe('improving');
        expect(trendLabel(0.10)).toBe('improving');
        expect(trendLabel(0.50)).toBe('improving');
    });

    it('trend_delta between -0.15 and -0.05 → degrading', () => {
        expect(trendLabel(-0.06)).toBe('degrading');
        expect(trendLabel(-0.10)).toBe('degrading');
        expect(trendLabel(-0.14)).toBe('degrading');
    });

    it('trend_delta < -0.15 → critical', () => {
        expect(trendLabel(-0.16)).toBe('critical');
        expect(trendLabel(-0.30)).toBe('critical');
        expect(trendLabel(-0.99)).toBe('critical');
    });

    it('boundary: -0.05 exactly → stable (not degrading)', () => {
        expect(trendLabel(-0.05)).toBe('stable');
    });

    it('boundary: -0.15 exactly → degrading (not critical)', () => {
        // -0.15 is NOT < -0.15, so it's degrading
        expect(trendLabel(-0.15)).toBe('degrading');
    });
});

describe('Week-over-Week Trend Delta', () => {
    const now = new Date('2026-03-07T12:00:00Z');

    function makeOutcomes(thisWeekSuccesses: number, thisWeekFailures: number,
                          lastWeekSuccesses: number, lastWeekFailures: number) {
        const outcomes: Array<{ timestamp: Date; success: boolean }> = [];
        const oneDay = 24 * 60 * 60 * 1000;

        // This week: spread across days 1-6 ago
        for (let i = 0; i < thisWeekSuccesses; i++) {
            outcomes.push({ timestamp: new Date(now.getTime() - (i + 1) * oneDay / 2), success: true });
        }
        for (let i = 0; i < thisWeekFailures; i++) {
            outcomes.push({ timestamp: new Date(now.getTime() - (i + 1) * oneDay / 3), success: false });
        }

        // Last week: spread across days 8-13 ago
        for (let i = 0; i < lastWeekSuccesses; i++) {
            outcomes.push({ timestamp: new Date(now.getTime() - (8 + i) * oneDay), success: true });
        }
        for (let i = 0; i < lastWeekFailures; i++) {
            outcomes.push({ timestamp: new Date(now.getTime() - (8 + i + 0.5) * oneDay), success: false });
        }

        return outcomes;
    }

    it('5 successes week1, 5 failures week2 → negative trend', () => {
        const outcomes = makeOutcomes(0, 5, 5, 0);
        const delta = computeTrendDelta(outcomes, now);
        expect(delta).not.toBeNull();
        expect(delta!).toBeLessThan(-0.15);  // critical degradation
    });

    it('stable performance → trend near 0', () => {
        const outcomes = makeOutcomes(3, 2, 3, 2);
        const delta = computeTrendDelta(outcomes, now);
        expect(delta).not.toBeNull();
        expect(Math.abs(delta!)).toBeLessThan(0.05);
    });

    it('improving: was 40% → now 80% → positive delta', () => {
        const outcomes = makeOutcomes(4, 1, 2, 3);
        const delta = computeTrendDelta(outcomes, now);
        expect(delta).not.toBeNull();
        expect(delta!).toBeGreaterThan(0.3);
    });

    it('no data in one week → null', () => {
        const outcomes = makeOutcomes(3, 2, 0, 0);
        const delta = computeTrendDelta(outcomes, now);
        expect(delta).toBeNull();
    });

    it('no data at all → null', () => {
        const delta = computeTrendDelta([], now);
        expect(delta).toBeNull();
    });
});

describe('Degradation Detection', () => {
    const baseAction: ActionTrend = {
        action_id: 'a1',
        context_id: 'c1',
        customer_id: 'cust1',
        action_name: 'test_action',
        trend_delta: null,
        raw_success_rate: 0.5,
        weighted_success_rate: 0.5,
        total_attempts: 10,
    };

    it('trend_delta < -0.15 → degradation alert emitted', () => {
        const scores = [
            { ...baseAction, action_id: 'a1', trend_delta: -0.20, weighted_success_rate: 0.30 },
            { ...baseAction, action_id: 'a2', trend_delta: -0.05, weighted_success_rate: 0.70 },
        ];
        const alerts = detectDegradation(scores);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].action_id).toBe('a1');
    });

    it('trend_delta = -0.15 exactly → NOT alerted (boundary)', () => {
        const scores = [{ ...baseAction, trend_delta: -0.15 }];
        const alerts = detectDegradation(scores);
        expect(alerts).toHaveLength(0);
    });

    it('null trend_delta → NOT alerted', () => {
        const scores = [{ ...baseAction, trend_delta: null }];
        const alerts = detectDegradation(scores);
        expect(alerts).toHaveLength(0);
    });

    it('multiple degraded actions → all emitted', () => {
        const scores = [
            { ...baseAction, action_id: 'a1', trend_delta: -0.20 },
            { ...baseAction, action_id: 'a2', trend_delta: -0.30 },
            { ...baseAction, action_id: 'a3', trend_delta: -0.01 },
        ];
        const alerts = detectDegradation(scores);
        expect(alerts).toHaveLength(2);
    });
});

describe('Score Flip (Contradiction) Detection', () => {
    const baseAction: ActionTrend = {
        action_id: 'a1',
        context_id: 'c1',
        customer_id: 'cust1',
        action_name: 'test_action',
        trend_delta: null,
        raw_success_rate: 0.5,
        weighted_success_rate: 0.5,
        total_attempts: 10,
    };

    it('score flip > 0.4 → event emitted', () => {
        const scores = [
            { ...baseAction, trend_delta: -0.50, weighted_success_rate: 0.35 },
        ];
        const flips = detectScoreFlips(scores);
        expect(flips).toHaveLength(1);
        expect(flips[0].score_flip_magnitude).toBeCloseTo(0.5, 2);
        expect(flips[0].old_success_rate).toBeCloseTo(0.85, 2);
        expect(flips[0].new_success_rate).toBeCloseTo(0.35, 2);
    });

    it('score flip < 0.4 → NOT emitted', () => {
        const scores = [
            { ...baseAction, trend_delta: -0.30, weighted_success_rate: 0.40 },
        ];
        const flips = detectScoreFlips(scores);
        expect(flips).toHaveLength(0);
    });

    it('positive flip > 0.4 → also emitted (recovering action)', () => {
        const scores = [
            { ...baseAction, trend_delta: 0.45, weighted_success_rate: 0.80 },
        ];
        const flips = detectScoreFlips(scores);
        expect(flips).toHaveLength(1);
        expect(flips[0].old_success_rate).toBeCloseTo(0.35, 2);
    });

    it('null trend_delta → NOT emitted', () => {
        const scores = [{ ...baseAction, trend_delta: null }];
        const flips = detectScoreFlips(scores);
        expect(flips).toHaveLength(0);
    });
});

describe('Business Hours vs After-Hours Split', () => {
    function makeAt(hour: number, success: boolean): { timestamp: Date; success: boolean } {
        const d = new Date('2026-03-07T00:00:00Z');
        d.setUTCHours(hour);
        return { timestamp: d, success };
    }

    it('outcomes during 9-17 UTC → business hours rate computed', () => {
        const outcomes = [
            makeAt(10, true), makeAt(11, true), makeAt(14, false),
        ];
        const rates = computeTimeOfDayRates(outcomes);
        expect(rates.businessHoursRate).toBeCloseTo(2 / 3, 4);
        expect(rates.afterHoursRate).toBeNull();
    });

    it('outcomes outside 9-17 UTC → after hours rate computed', () => {
        const outcomes = [
            makeAt(2, true), makeAt(3, false), makeAt(22, true), makeAt(23, false),
        ];
        const rates = computeTimeOfDayRates(outcomes);
        expect(rates.businessHoursRate).toBeNull();
        expect(rates.afterHoursRate).toBeCloseTo(0.5, 4);
    });

    it('mixed outcomes → both rates computed correctly', () => {
        const outcomes = [
            makeAt(10, true), makeAt(11, true),                 // business: 100%
            makeAt(2, true), makeAt(3, false), makeAt(22, false), // after: 33%
        ];
        const rates = computeTimeOfDayRates(outcomes);
        expect(rates.businessHoursRate).toBeCloseTo(1.0, 4);
        expect(rates.afterHoursRate).toBeCloseTo(1 / 3, 4);
    });

    it('no outcomes → both null', () => {
        const rates = computeTimeOfDayRates([]);
        expect(rates.businessHoursRate).toBeNull();
        expect(rates.afterHoursRate).toBeNull();
    });
});
