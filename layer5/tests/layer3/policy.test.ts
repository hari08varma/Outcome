/**
 * Layerinfinite — Unit Tests: Policy Engine
 * Tests the explore/exploit/escalate decision tree.
 * Run: npx vitest run tests/layer3/policy.test.ts
 */

import { describe, it, expect } from 'vitest';
import { getPolicyDecision, DEFAULT_POLICY_CONFIG, DEFAULT_TRUST, AgentTrustScore, CustomerPolicyConfig } from '../../api/lib/policy-engine.js';
import { ScoredAction } from '../../api/lib/scoring.js';

const EXISTING_TRUST: AgentTrustScore = {
    trust_score: 0.5,
    trust_status: 'probation',
    consecutive_failures: 0,
};

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
        recommendation: 'recommend',
        ...overrides,
    };
}

describe('Policy Engine — Decision Tree', () => {

    it('missing trust row fallback behaves as new agent exploration', () => {
        const actions = [makeAction({ action_id: 'a1', total_attempts: 5 })];

        const viaDefault = getPolicyDecision({
            rankedActions: actions,
            agentTrust: null,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });

        const viaExplicitNew = getPolicyDecision({
            rankedActions: actions,
            agentTrust: { trust_score: 0, trust_status: 'new', consecutive_failures: 0 },
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });

        expect(DEFAULT_TRUST.trust_score).toBe(0);
        expect(DEFAULT_TRUST.trust_status).toBe('new');
        expect(viaDefault.policy).toBe('explore');
        expect(viaDefault.reason).toBe('agent_new_no_history');
        expect(viaExplicitNew.policy).toBe('explore');
        expect(viaExplicitNew.reason).toBe('agent_new_no_history');
    });

    it('suspended agent always returns escalate', () => {
        const trust: AgentTrustScore = { trust_score: 0.1, trust_status: 'suspended', consecutive_failures: 10 };
        const result = getPolicyDecision({
            rankedActions: [makeAction({ composite_score: 0.95 })],
            agentTrust: trust,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });
        expect(result.policy).toBe('escalate');
        expect(result.reason).toBe('agent_suspended');
    });

    it('cold start returns explore with reason cold_start', () => {
        const result = getPolicyDecision({
            rankedActions: [makeAction({ composite_score: 0.9, confidence: 0.1, total_attempts: 2 })],
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: true,
        });
        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('cold_start');
        expect(result.explorationTarget).toBeDefined();
    });

    it('all low confidence returns explore (cold_start)', () => {
        const actions = [
            makeAction({ action_id: 'a1', confidence: 0.1, total_attempts: 3 }),
            makeAction({ action_id: 'a2', confidence: 0.2, total_attempts: 1 }),
        ];
        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });
        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('cold_start');
        // Should target lowest-sample action (a2 has 1 attempt)
        expect(result.explorationTarget).toBe('a2');
    });

    it('conservative customer exploits above 0.8 always', () => {
        const config: CustomerPolicyConfig = { ...DEFAULT_POLICY_CONFIG, risk_tolerance: 'conservative' };
        const result = getPolicyDecision({
            rankedActions: [makeAction({ composite_score: 0.85, confidence: 0.9 })],
            agentTrust: EXISTING_TRUST,
            customerConfig: config,
            coldStartActive: false,
        });
        expect(result.policy).toBe('exploit');
        expect(result.reason).toBe('conservative_high_score');
    });

    it('epsilon-greedy: randomFn=()=>0.04 returns explore', () => {
        const actions = [
            makeAction({ action_id: 'top', composite_score: 0.90, confidence: 0.9 }),
            makeAction({ action_id: 'second', composite_score: 0.70, confidence: 0.8 }),
        ];
        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        }, () => 0.04);  // < 0.05 epsilon
        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('epsilon_greedy_explore');
        expect(result.explorationTarget).toBe('second');
    });

    it('epsilon-greedy: randomFn=()=>0.96 returns exploit', () => {
        const actions = [
            makeAction({ action_id: 'top', composite_score: 0.90, confidence: 0.9 }),
            makeAction({ action_id: 'second', composite_score: 0.70 }),
        ];
        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        }, () => 0.96);  // > 0.05 epsilon
        expect(result.policy).toBe('exploit');
        expect(result.reason).toBe('epsilon_greedy_exploit');
        expect(result.selectedAction).toBe('top');
    });

    it('all scores < 0.2 returns escalate', () => {
        const actions = [
            makeAction({ action_id: 'a1', composite_score: 0.15, confidence: 0.8 }),
            makeAction({ action_id: 'a2', composite_score: 0.10, confidence: 0.7 }),
        ];
        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });
        expect(result.policy).toBe('escalate');
        expect(result.reason).toBe('no_reliable_action');
    });

    it('medium score (0.5-0.85) uses confidence-weighted exploit', () => {
        const result = getPolicyDecision({
            rankedActions: [makeAction({ composite_score: 0.65, confidence: 0.8 })],
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        }, () => 0.5);  // < 0.8 confidence = exploit
        expect(result.policy).toBe('exploit');
        expect(result.reason).toBe('confidence_weighted_exploit');
    });

    it('no actions available returns escalate', () => {
        const result = getPolicyDecision({
            rankedActions: [],
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });
        expect(result.policy).toBe('escalate');
        expect(result.reason).toBe('no_actions_available');
    });

    it('ambiguous low-separation rankings return abstain', () => {
        const actions = [
            makeAction({ action_id: 'a1', action_name: 'retry_with_context', composite_score: 0.58, confidence: 0.62 }),
            makeAction({ action_id: 'a2', action_name: 'escalate_to_human', composite_score: 0.56, confidence: 0.61 }),
        ];

        const result = getPolicyDecision({
            rankedActions: actions,
            agentTrust: EXISTING_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        });

        expect(result.policy).toBe('abstain');
        expect(result.reason).toBe('ambiguous_low_separation');
        expect(result.human_review_required).toBe(true);
    });
});
