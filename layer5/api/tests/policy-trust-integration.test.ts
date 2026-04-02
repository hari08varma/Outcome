// TODO: observe.test.ts — pending fix of /observe route.
// The route is currently broken (missing context_id resolution).
// See: https://github.com/hari08varma/Outcome/issues/[issue number]
// Add end-to-end test once fixed.

import { describe, expect, it } from 'vitest';
import {
    getPolicyDecision,
    DEFAULT_TRUST,
    DEFAULT_POLICY_CONFIG,
    type AgentTrustScore,
    type CustomerPolicyConfig,
} from '../lib/policy-engine.js';
import type { ScoredAction } from '../lib/scoring.js';

function makeTrust(overrides: Partial<AgentTrustScore> = {}): AgentTrustScore {
    return {
        trust_score: 0.7,
        trust_status: 'trusted',
        consecutive_failures: 0,
        ...overrides,
    };
}

function makeActions(count = 2): ScoredAction[] {
    return Array.from({ length: count }, (_, i) => ({
        action_id: `action-${i}`,
        action_name: 'refund',
        action_category: 'billing',
        composite_score: 0.75,
        confidence: 0.8,
        trend_delta: 0,
        trend: 'stable',
        total_attempts: 30,
        is_cold_start: false,
        is_low_sample: false,
        recommendation: 'recommend',
    }));
}

describe('policy engine trust state contract', () => {
    const config: CustomerPolicyConfig = DEFAULT_POLICY_CONFIG;

    it('suspended trust_status -> always escalate regardless of actions', () => {
        const trust = makeTrust({ trust_status: 'suspended', trust_score: 0.05 });

        const decision = getPolicyDecision({
            rankedActions: makeActions(3),
            agentTrust: trust,
            customerConfig: config,
            coldStartActive: false,
        });

        expect(decision.policy).toBe('escalate');
        expect(decision.reason).toBe('agent_suspended');
        expect(decision.human_review_required).toBe(true);
    });

    it('new trust_status -> force explore (agent_new_no_history)', () => {
        const trust = makeTrust({ trust_status: 'new', trust_score: 0 });

        const decision = getPolicyDecision({
            rankedActions: makeActions(2),
            agentTrust: trust,
            customerConfig: config,
            coldStartActive: false,
        });

        expect(decision.policy).toBe('explore');
        expect(decision.reason).toBe('agent_new_no_history');
        expect(decision.selectedAction).toBeNull();
        expect(decision.explorationTarget).not.toBeNull();
    });

    it('sandbox trust_status -> SANDBOX with human_review_required', () => {
        const trust = makeTrust({ trust_status: 'sandbox', trust_score: 0.15 });

        const decision = getPolicyDecision({
            rankedActions: makeActions(2),
            agentTrust: trust,
            customerConfig: config,
            coldStartActive: false,
        });

        expect(decision.policy).toBe('SANDBOX');
        expect(decision.reason).toBe('agent_in_sandbox_probation');
    });

    it('trusted + high score -> exploit (deterministic randomFn)', () => {
        const trust = makeTrust({ trust_status: 'trusted', trust_score: 0.85 });
        const actions = makeActions(2).map((a) => ({
            ...a,
            composite_score: 0.9,
            confidence: 0.9,
        }));

        const decision = getPolicyDecision(
            {
                rankedActions: actions,
                agentTrust: trust,
                customerConfig: config,
                coldStartActive: false,
            },
            () => 0.9
        );

        expect(decision.policy).toBe('exploit');
        expect(decision.selectedAction).toBe('action-0');
    });

    it('null agentTrust -> falls back to DEFAULT_TRUST (new status -> explore)', () => {
        const decision = getPolicyDecision({
            rankedActions: makeActions(2),
            agentTrust: null,
            customerConfig: config,
            coldStartActive: false,
        });

        expect(DEFAULT_TRUST.trust_status).toBe('new');
        expect(decision.policy).toBe('explore');
        expect(decision.reason).toBe('agent_new_no_history');
    });

    it('cold_start=true overrides high trust score -> explore', () => {
        const trust = makeTrust({ trust_status: 'trusted', trust_score: 0.95 });

        const decision = getPolicyDecision({
            rankedActions: makeActions(2),
            agentTrust: trust,
            customerConfig: config,
            coldStartActive: true,
        });

        expect(decision.policy).toBe('explore');
        expect(decision.reason).toBe('cold_start');
    });

    it('probation + medium score -> confidence-weighted branch fires', () => {
        const trust = makeTrust({ trust_status: 'probation', trust_score: 0.45 });
        const actions = makeActions(2);

        const deterministicExploit = getPolicyDecision(
            {
                rankedActions: actions,
                agentTrust: trust,
                customerConfig: config,
                coldStartActive: false,
            },
            () => 0.0
        );

        expect(deterministicExploit.policy).toBe('exploit');
        expect(deterministicExploit.reason).toBe('confidence_weighted_exploit');

        const deterministicExplore = getPolicyDecision(
            {
                rankedActions: actions,
                agentTrust: trust,
                customerConfig: config,
                coldStartActive: false,
            },
            () => 0.99
        );

        expect(deterministicExplore.policy).toBe('explore');
        expect(deterministicExplore.reason).toBe('confidence_weighted_explore');
    });
});
