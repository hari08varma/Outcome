/**
 * Layerinfinite — Phase 5 Unit Tests: Adaptive Policy Engine
 * ══════════════════════════════════════════════════════════════
 * Tests the policy-engine decision tree with Phase 5 real-trust
 * wiring scenarios. Uses injectable randomFn for determinism.
 *
 * Run: npx vitest run tests/layerinfinite/policy.test.ts
 * ══════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
    getPolicyDecision,
    DEFAULT_POLICY_CONFIG,
    AgentTrustScore,
    CustomerPolicyConfig,
} from '../../api/lib/policy-engine.js';
import { ScoredAction } from '../../api/lib/scoring.js';

const TRUSTED_AGENT: AgentTrustScore = {
    trust_score: 0.75,
    trust_status: 'trusted',
    consecutive_failures: 0,
};

// ── Test helper: build a ScoredAction with sensible defaults ──
function makeAction(overrides: Partial<ScoredAction> = {}): ScoredAction {
    return {
        action_id: 'act-001',
        action_name: 'test_action',
        action_category: 'recovery',
        composite_score: 0.7,
        confidence: 0.8,
        trend_delta: null,
        trend: 'stable',
        total_attempts: 50,
        is_cold_start: false,
        is_low_sample: false,
        recommendation: 'recommend',
        ...overrides,
    };
}

// ══════════════════════════════════════════════════════════════
// Test Suite: Phase 5 — Adaptive Policy Engine
// ══════════════════════════════════════════════════════════════

describe('Phase 5 — Adaptive Policy Engine', () => {

    // ── Test 1: Suspended agent → escalate ──────────────────────
    it('suspended agent returns escalate immediately', () => {
        const suspendedTrust: AgentTrustScore = {
            trust_score: 0.15,
            trust_status: 'suspended',
            consecutive_failures: 7,
        };

        const result = getPolicyDecision({
            rankedActions: [
                makeAction({ composite_score: 0.95, confidence: 0.99 }),  // excellent action
                makeAction({ action_id: 'act-002', composite_score: 0.85 }),
            ],
            agentTrust: suspendedTrust,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });

        expect(result.policy).toBe('escalate');
        expect(result.reason).toBe('agent_suspended');
        expect(result.selectedAction).toBeNull();
        expect(result.explorationTarget).toBeNull();
    });

    // ── Test 2: Cold start → explore ────────────────────────────
    it('cold start returns explore with exploration target', () => {
        const actions = [
            makeAction({ action_id: 'high-sample', confidence: 0.1, total_attempts: 8 }),
            makeAction({ action_id: 'low-sample', confidence: 0.05, total_attempts: 2 }),
        ];

        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: TRUSTED_AGENT,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: true,
        });

        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('cold_start');
        // Should target the lowest-sample action for maximum exploration value
        expect(result.explorationTarget).toBe('low-sample');
        expect(result.selectedAction).toBeNull();
    });

    // ── Test 3: Conservative customer + top_score > 0.8 → exploit ─
    it('conservative customer always exploits above 0.8', () => {
        const conservativeConfig: CustomerPolicyConfig = {
            ...DEFAULT_POLICY_CONFIG,
            risk_tolerance: 'conservative',
        };

        // Run 20 times with different random seeds — should ALWAYS exploit
        for (let i = 0; i < 20; i++) {
            const randomValue = i / 20;  // 0.0 to 0.95
            const result = getPolicyDecision({
                rankedActions: [
                    makeAction({ action_id: 'top', composite_score: 0.85, confidence: 0.9 }),
                    makeAction({ action_id: 'alt', composite_score: 0.60 }),
                ],
                agentTrust: TRUSTED_AGENT,
                customerConfig: conservativeConfig,
                coldStartActive: false,
            }, () => randomValue);

            expect(result.policy).toBe('exploit');
            expect(result.reason).toBe('conservative_high_score');
            expect(result.selectedAction).toBe('top');
        }
    });

    // ── Test 4: Epsilon-greedy randomFn=0.04 → explore ──────────
    it('epsilon-greedy: randomFn=0.04 triggers exploration (< 0.05 epsilon)', () => {
        const actions = [
            makeAction({ action_id: 'top', composite_score: 0.90, confidence: 0.9 }),
            makeAction({ action_id: 'second', composite_score: 0.70, confidence: 0.85 }),
        ];

        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: TRUSTED_AGENT,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        }, () => 0.04);  // 0.04 < 0.05 epsilon → explore

        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('epsilon_greedy_explore');
        expect(result.explorationTarget).toBe('second');
        expect(result.selectedAction).toBeNull();
    });

    // ── Test 5: Epsilon-greedy randomFn=0.96 → exploit ──────────
    it('epsilon-greedy: randomFn=0.96 triggers exploitation (> 0.05 epsilon)', () => {
        const actions = [
            makeAction({ action_id: 'top', composite_score: 0.90, confidence: 0.9 }),
            makeAction({ action_id: 'second', composite_score: 0.70, confidence: 0.85 }),
        ];

        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: TRUSTED_AGENT,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        }, () => 0.96);  // 0.96 > 0.05 epsilon → exploit

        expect(result.policy).toBe('exploit');
        expect(result.reason).toBe('epsilon_greedy_exploit');
        expect(result.selectedAction).toBe('top');
        expect(result.explorationTarget).toBeNull();
    });

    // ── Test 6: All scores < escalation_score → escalate ────────
    it('all scores below escalation threshold → escalate', () => {
        const actions = [
            makeAction({ action_id: 'weak-1', composite_score: 0.15, confidence: 0.8 }),
            makeAction({ action_id: 'weak-2', composite_score: 0.10, confidence: 0.7 }),
            makeAction({ action_id: 'weak-3', composite_score: 0.05, confidence: 0.6 }),
        ];

        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: TRUSTED_AGENT,
            customerConfig: DEFAULT_POLICY_CONFIG,  // escalation_score = 0.20
            coldStartActive: false,
        });

        expect(result.policy).toBe('escalate');
        expect(result.reason).toBe('no_reliable_action');
        expect(result.selectedAction).toBeNull();
    });

    // ── Test 7: Ambiguous low-separation rankings → abstain ─────
    it('ambiguous low-separation rankings trigger strict abstain', () => {
        const actions = [
            makeAction({ action_id: 'a1', action_name: 'retry_with_context', composite_score: 0.58, confidence: 0.62 }),
            makeAction({ action_id: 'a2', action_name: 'escalate_to_human', composite_score: 0.56, confidence: 0.61 }),
        ];

        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: TRUSTED_AGENT,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });

        expect(result.policy).toBe('abstain');
        expect(result.reason).toBe('ambiguous_low_separation');
        expect(result.human_review_required).toBe(true);
        expect(result.selectedAction).toBeNull();
    });
});
