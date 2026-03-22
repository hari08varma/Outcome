/**
 * Layerinfinite — lib/policy-engine.ts
 * ══════════════════════════════════════════════════════════════
 * Explore / Exploit / Escalate decision tree.
 *
 * This file contains ZERO database calls. It is a pure function
 * that takes ranked actions + trust + config and returns a
 * deterministic policy decision.
 *
 * randomFn is injectable for testing (deterministic in tests).
 * ══════════════════════════════════════════════════════════════
 */

import { ScoredAction } from './scoring.js';

// ── Input types ──────────────────────────────────────────────

export interface AgentTrustScore {
    trust_score: number;       // 0.0–1.0
    trust_status: 'trusted' | 'probation' | 'sandbox' | 'suspended' | 'new' | 'degraded';
    consecutive_failures: number;
}

export interface CustomerPolicyConfig {
    risk_tolerance: 'conservative' | 'balanced' | 'aggressive';
    escalation_score: number;  // below this → escalate (default 0.2)
    exploration_rate: number;  // epsilon for epsilon-greedy (default 0.05)
    min_confidence: number;  // below this → cold start (default 0.3)
}

export interface PolicyDecision {
    policy: 'exploit' | 'explore' | 'escalate' | 'SANDBOX';
    reason: string;
    selectedAction: string | null;
    explorationTarget: string | null;
    human_review_required?: boolean;
    sandbox_message?: string;
}

// ── Default config (used when customer config is missing) ────

export const DEFAULT_POLICY_CONFIG: CustomerPolicyConfig = {
    risk_tolerance: 'balanced',
    escalation_score: 0.20,
    exploration_rate: 0.05,
    min_confidence: 0.30,
};

export const DEFAULT_TRUST: AgentTrustScore = {
    trust_score: 0.5,
    trust_status: 'trusted',
    consecutive_failures: 0,
};

// ── Decision tree ────────────────────────────────────────────

export function getPolicyDecision(
    params: {
        rankedActions: ScoredAction[];
        agentTrust: AgentTrustScore | null | undefined;
        customerConfig: CustomerPolicyConfig;
        coldStartActive: boolean;
    },
    randomFn: () => number = Math.random
): PolicyDecision {
    // ── FIX: null guard — use DEFAULT_TRUST if trust not available ──
    const agentTrust = params.agentTrust ?? DEFAULT_TRUST;
    const { rankedActions, customerConfig, coldStartActive } = params;

    // ── Rule 1: Suspended agent → always escalate ─────────────
    if (agentTrust.trust_status === 'suspended') {
        return {
            policy: 'escalate',
            reason: 'agent_suspended',
            selectedAction: null,
            explorationTarget: null,
            human_review_required: true,
        };
    }

    const topAction = rankedActions[0];

    // ── Rule 1.5: Sandbox agent → flag for review but execute top action
    if (agentTrust.trust_status === 'sandbox') {
        return {
            policy: 'SANDBOX',
            reason: 'agent_in_sandbox_probation',
            selectedAction: topAction?.action_id ?? null,
            explorationTarget: null,
            human_review_required: true,
            sandbox_message: 'Agent is in sandbox mode. ' +
                'All actions will execute but require human review. ' +
                `Trust score: ${agentTrust.trust_score.toFixed(3)}. ` +
                `Threshold to exit sandbox: 0.3`,
        };
    }

    // ── Rule 2: Cold start OR all confidence < threshold ──────
    const allLowConfidence = rankedActions.length > 0 &&
        rankedActions.every(a => a.confidence < customerConfig.min_confidence);

    if (coldStartActive || allLowConfidence) {
        // Suggest the action with the lowest sample count (most exploration value)
        const target = rankedActions.length > 0
            ? [...rankedActions].sort((a, b) => a.total_attempts - b.total_attempts)[0]
            : null;

        return {
            policy: 'explore',
            reason: 'cold_start',
            selectedAction: null,
            explorationTarget: target?.action_id ?? null,
        };
    }

    if (!topAction) {
        return {
            policy: 'escalate',
            reason: 'no_actions_available',
            selectedAction: null,
            explorationTarget: null,
            human_review_required: true,
        };
    }

    const topScore = topAction.composite_score;
    const topConf = topAction.confidence;

    // ── Rule 3: Conservative + top > 0.8 → always exploit ─────
    if (customerConfig.risk_tolerance === 'conservative' && topScore > 0.8) {
        return {
            policy: 'exploit',
            reason: 'conservative_high_score',
            selectedAction: topAction.action_id,
            explorationTarget: null,
        };
    }

    // ── Rule 4: High score + high confidence → epsilon-greedy ─
    if (topScore > 0.85 && topConf > 0.8) {
        const roll = randomFn();
        if (roll < customerConfig.exploration_rate) {
            // Explore: pick 2nd action (or lowest-sample action)
            const exploreTarget = rankedActions.length > 1
                ? rankedActions[1]
                : topAction;

            return {
                policy: 'explore',
                reason: 'epsilon_greedy_explore',
                selectedAction: null,
                explorationTarget: exploreTarget.action_id,
            };
        }
        return {
            policy: 'exploit',
            reason: 'epsilon_greedy_exploit',
            selectedAction: topAction.action_id,
            explorationTarget: null,
        };
    }

    // ── Rule 5: Medium score (0.5–0.85) → exploit with probability
    if (topScore >= 0.5 && topScore <= 0.85) {
        const exploitProbability = topConf;  // confidence × 100%
        const roll = randomFn();

        if (roll < exploitProbability) {
            return {
                policy: 'exploit',
                reason: 'confidence_weighted_exploit',
                selectedAction: topAction.action_id,
                explorationTarget: null,
            };
        }
        // Explore the 2nd-best action
        const exploreTarget = rankedActions.length > 1
            ? rankedActions[1]
            : topAction;
        return {
            policy: 'explore',
            reason: 'confidence_weighted_explore',
            selectedAction: null,
            explorationTarget: exploreTarget.action_id,
        };
    }

    // ── Rule 6: All scores < escalation threshold → escalate ──
    if (rankedActions.every(a => a.composite_score < customerConfig.escalation_score)) {
        return {
            policy: 'escalate',
            reason: 'no_reliable_action',
            selectedAction: null,
            explorationTarget: null,
        };
    }

    // ── Rule 7: Default → explore 2nd action ──────────────────
    const fallbackTarget = rankedActions.length > 1
        ? rankedActions[1]
        : topAction;

    return {
        policy: 'explore',
        reason: 'default_exploration',
        selectedAction: null,
        explorationTarget: fallbackTarget.action_id,
    };
}
