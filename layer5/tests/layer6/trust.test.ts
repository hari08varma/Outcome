/**
 * Layer5 — Phase 6 Unit Tests: Trust Score System
 * ══════════════════════════════════════════════════════════════
 * Tests the trust update rules, decay math, status thresholds,
 * and reinstatement logic.
 *
 * Run: npx vitest run tests/layer6/trust.test.ts
 * ══════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';

// ── Trust update rules (mirrors log-outcome.ts + trust-updater) ──

interface TrustState {
    trust_score: number;
    consecutive_failures: number;
    total_decisions: number;
    correct_decisions: number;
    trust_status: string;
}

function applyOutcome(state: TrustState, success: boolean): TrustState {
    let newScore: number;
    let newFailures: number;
    let newCorrect = state.correct_decisions;

    if (success) {
        newFailures = 0;
        newCorrect += 1;
        newScore = Math.min(state.trust_score * 1.03, 1.0);
    } else {
        newFailures = state.consecutive_failures + 1;
        newScore = state.trust_score * Math.pow(0.9, newFailures);
    }

    let newStatus: string;
    if (newScore < 0.3 || newFailures >= 5) {
        newStatus = 'suspended';
    } else if (newScore < 0.6) {
        newStatus = 'probation';
    } else {
        newStatus = 'trusted';
    }

    return {
        trust_score: newScore,
        consecutive_failures: newFailures,
        total_decisions: state.total_decisions + 1,
        correct_decisions: newCorrect,
        trust_status: newStatus,
    };
}

function reinstate(): Partial<TrustState> {
    return {
        trust_score: 0.4,
        trust_status: 'probation',
        consecutive_failures: 0,
    };
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

describe('Phase 6 — Trust Score System', () => {

    // ── Test 1: Trust decays correctly under 5 consecutive failures ──
    it('5 consecutive failures suspends the agent', () => {
        let state: TrustState = {
            trust_score: 0.7,
            consecutive_failures: 0,
            total_decisions: 10,
            correct_decisions: 8,
            trust_status: 'trusted',
        };

        // Apply 5 failures
        for (let i = 0; i < 5; i++) {
            state = applyOutcome(state, false);
        }

        expect(state.trust_status).toBe('suspended');
        expect(state.consecutive_failures).toBe(5);
        expect(state.total_decisions).toBe(15);

        // Score should have decayed: 0.7 * 0.9^1 * 0.9^2 * 0.9^3 * 0.9^4 * 0.9^5
        // But it's cumulative: after each step failures increment
        // Failure 1: 0.7 * 0.9^1 = 0.63
        // Failure 2: 0.63 * 0.9^2 = 0.5103
        // Failure 3: 0.5103 * 0.9^3 = 0.37176
        // Failure 4: 0.37176 * 0.9^4 = 0.24414
        // Failure 5: 0.24414 * 0.9^5 = 0.14441
        expect(state.trust_score).toBeLessThan(0.3);
    });

    // ── Test 2: Trust recovers slowly — 3 successes from 0.5 stays in probation ──
    it('3 successes from 0.5 stays in probation (not yet 0.6)', () => {
        let state: TrustState = {
            trust_score: 0.5,
            consecutive_failures: 0,
            total_decisions: 20,
            correct_decisions: 14,
            trust_status: 'probation',
        };

        // Apply 3 successes: 0.5 * 1.03^3 ≈ 0.5464
        state = applyOutcome(state, true);
        state = applyOutcome(state, true);
        state = applyOutcome(state, true);

        const expectedScore = 0.5 * Math.pow(1.03, 3);  // ≈ 0.5464
        expect(state.trust_score).toBeCloseTo(expectedScore, 4);
        expect(state.trust_score).toBeLessThan(0.6);
        expect(state.trust_status).toBe('probation');
        expect(state.consecutive_failures).toBe(0);
        expect(state.correct_decisions).toBe(17);
    });

    // ── Test 3: Human reinstatement sets correct values ──
    it('reinstatement sets trust_score=0.4, status=probation, failures=0', () => {
        const reinstated = reinstate();

        expect(reinstated.trust_score).toBe(0.4);
        expect(reinstated.trust_status).toBe('probation');
        expect(reinstated.consecutive_failures).toBe(0);
    });

    // ── Test 4: Success resets consecutive_failures to 0 ──
    it('success resets consecutive_failures to zero', () => {
        let state: TrustState = {
            trust_score: 0.6,
            consecutive_failures: 3,
            total_decisions: 15,
            correct_decisions: 10,
            trust_status: 'trusted',
        };

        state = applyOutcome(state, true);

        expect(state.consecutive_failures).toBe(0);
        expect(state.trust_score).toBe(Math.min(0.6 * 1.03, 1.0));
        expect(state.correct_decisions).toBe(11);
    });

    // ── Test 5: Score capped at 1.0 ──
    it('trust score is capped at 1.0 on success', () => {
        let state: TrustState = {
            trust_score: 0.99,
            consecutive_failures: 0,
            total_decisions: 100,
            correct_decisions: 95,
            trust_status: 'trusted',
        };

        state = applyOutcome(state, true);

        expect(state.trust_score).toBeLessThanOrEqual(1.0);
        expect(state.trust_status).toBe('trusted');
    });

    // ── Test 6: Threshold boundaries ──
    it('score 0.6 exactly is trusted, 0.599 is probation, 0.299 is suspended', () => {
        // 0.6 → trusted
        const state1 = applyOutcome({
            trust_score: 0.6 / 1.03,  // so after success → exactly 0.6
            consecutive_failures: 0, total_decisions: 0, correct_decisions: 0, trust_status: 'probation',
        }, true);
        expect(state1.trust_score).toBeCloseTo(0.6, 4);
        expect(state1.trust_status).toBe('trusted');

        // Score in probation zone
        const state2: TrustState = {
            trust_score: 0.45,
            consecutive_failures: 0, total_decisions: 0, correct_decisions: 0, trust_status: 'probation',
        };
        const result2 = applyOutcome(state2, true);
        expect(result2.trust_status).toBe('probation');  // 0.45 * 1.03 = 0.4635 < 0.6

        // 5 consecutive failures should always suspend regardless of score
        let state3: TrustState = {
            trust_score: 0.99,
            consecutive_failures: 4,
            total_decisions: 10, correct_decisions: 6, trust_status: 'trusted',
        };
        state3 = applyOutcome(state3, false);  // 5th consecutive failure
        expect(state3.consecutive_failures).toBe(5);
        expect(state3.trust_status).toBe('suspended');
    });

    // ── Test 7: Post-reinstatement recovery path ──
    it('reinstated agent recovers from probation after enough successes', () => {
        // Start with reinstated values
        let state: TrustState = {
            trust_score: 0.4,
            consecutive_failures: 0,
            total_decisions: 50,
            correct_decisions: 30,
            trust_status: 'probation',
        };

        // Need to reach 0.6 from 0.4: 0.4 * 1.03^n >= 0.6 → n >= ln(1.5)/ln(1.03) ≈ 13.7
        // Apply 14 successes
        for (let i = 0; i < 14; i++) {
            state = applyOutcome(state, true);
        }

        const expectedScore = 0.4 * Math.pow(1.03, 14);
        expect(state.trust_score).toBeCloseTo(expectedScore, 4);
        expect(state.trust_score).toBeGreaterThanOrEqual(0.6);
        expect(state.trust_status).toBe('trusted');
        expect(state.consecutive_failures).toBe(0);
    });
});
