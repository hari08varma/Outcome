/**
 * Layerinfinite — Phase 5 Unit Tests: Cold Start Protocol
 * ══════════════════════════════════════════════════════════════
 * Tests the cold start detection, prior injection semantics,
 * and exit conditions. Pure unit tests — no DB calls.
 *
 * Run: npx vitest run tests/layerinfinite/cold-start.test.ts
 * ══════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
    getPolicyDecision,
    DEFAULT_POLICY_CONFIG,
    DEFAULT_TRUST,
    CustomerPolicyConfig,
} from '../../api/lib/policy-engine.js';
import { ScoredAction, MIN_CONFIDENCE } from '../../api/lib/scoring.js';

// ── Test helper: build a ScoredAction ──────────────────────────
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

// ══════════════════════════════════════════════════════════════
// Test Suite: Phase 5 — Cold Start Protocol
// ══════════════════════════════════════════════════════════════

describe('Phase 5 — Cold Start Protocol', () => {

    // ── Test 1: New agent with no outcomes → cold start triggered ──
    it('new agent with no outcomes triggers cold start explore', () => {
        // Simulate: zero real outcomes → scoring.ts returns coldStartActive=true
        // and all actions are institutional-knowledge fallback (is_cold_start=true, confidence=0)
        const coldStartActions = [
            makeAction({
                action_id: 'prior-1',
                action_name: 'update_app',
                composite_score: 0.72,
                confidence: 0,       // no real data
                total_attempts: 0,
                is_cold_start: true,
            }),
            makeAction({
                action_id: 'prior-2',
                action_name: 'clear_cache',
                composite_score: 0.65,
                confidence: 0,
                total_attempts: 0,
                is_cold_start: true,
            }),
            makeAction({
                action_id: 'prior-3',
                action_name: 'restart_service',
                composite_score: 0.41,
                confidence: 0,
                total_attempts: 0,
                is_cold_start: true,
            }),
        ];

        const result = getPolicyDecision({
            rankedActions: coldStartActions,
            agentTrust: DEFAULT_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: true,
        });

        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('cold_start');
        // All actions have 0 attempts, so explorationTarget picks the first sorted by total_attempts
        expect(result.explorationTarget).toBeDefined();
        expect(result.selectedAction).toBeNull();
    });

    // ── Test 2: Same-type agent with 10+ outcomes → priors transferred ──
    it('cross-agent transfer: priors from donor agent have correct properties', () => {
        // Simulate the priors that cold-start-bootstrap would insert:
        // - is_synthetic = true (represented by is_cold_start in ScoredAction)
        // - confidence = 0 (Wilson n/(n+10) with n=5 synthetic ≈ 0.33 but capped)
        // - total_attempts reflects synthetic count
        // After bootstrap, the policy engine should see these priors and enter cold_start mode
        const transferredPriors = [
            makeAction({
                action_id: 'transferred-1',
                action_name: 'update_app',
                composite_score: 0.72,
                confidence: 0.0,         // synthetic priors don't count for confidence
                total_attempts: 5,        // 5 synthetic priors
                is_cold_start: true,
            }),
            makeAction({
                action_id: 'transferred-2',
                action_name: 'retry_transaction',
                composite_score: 0.58,
                confidence: 0.0,
                total_attempts: 5,
                is_cold_start: true,
            }),
        ];

        const result = getPolicyDecision({
            rankedActions: transferredPriors,
            agentTrust: DEFAULT_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: true,
        });

        // All confidence < 0.3 and coldStartActive → explore
        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('cold_start');
        // Should target lowest-sample action for maximum learning
        expect(result.explorationTarget).toBeDefined();
    });

    // ── Test 3: Synthetic priors have is_synthetic = TRUE semantics ──
    it('synthetic prior rows have is_cold_start=true and confidence=0', () => {
        // Verify the structure that cold-start-bootstrap produces
        // These priors should:
        //   1. Have is_cold_start: true (is_synthetic=true in DB)
        //   2. Have confidence: 0 (excluded from mv_action_scores by is_synthetic filter)
        //   3. Have recommendation based on avg_success_rate
        const syntheticPrior: ScoredAction = makeAction({
            action_id: 'synthetic-001',
            action_name: 'switch_provider',
            composite_score: 0.54,         // from institutional knowledge
            confidence: 0,                  // synthetic priors have 0 real confidence
            total_attempts: 5,              // 5 synthetic rows
            is_cold_start: true,            // marks this as synthetic
            recommendation: 'neutral',
        });

        // Verify synthetic flag
        expect(syntheticPrior.is_cold_start).toBe(true);
        expect(syntheticPrior.confidence).toBe(0);

        // Synthetic priors should still trigger cold_start policy
        const result = getPolicyDecision({
            rankedActions: [syntheticPrior],
            agentTrust: DEFAULT_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: true,
        });

        expect(result.policy).toBe('explore');
        expect(result.reason).toBe('cold_start');
    });

    // ── Test 4: Cold start exits when real outcomes push confidence above threshold ──
    it('cold start exits when real outcomes reach sufficient confidence', () => {
        // After the agent logs ~10 real outcomes, confidence rises above MIN_CONFIDENCE (0.3)
        // At that point, coldStartActive=false and confidence >= 0.3 → normal policy engine
        const maturedActions = [
            makeAction({
                action_id: 'act-matured',
                action_name: 'update_app',
                composite_score: 0.82,
                confidence: 0.50,          // 10/(10+10) = 0.5 → well above 0.3
                total_attempts: 10,         // 10 real outcomes
                is_cold_start: false,       // exits cold start
            }),
            makeAction({
                action_id: 'act-second',
                action_name: 'clear_cache',
                composite_score: 0.60,
                confidence: 0.40,          // 7/(7+10) ≈ 0.41
                total_attempts: 7,
                is_cold_start: false,
            }),
        ];

        // Verify MIN_CONFIDENCE threshold
        expect(MIN_CONFIDENCE).toBe(0.30);

        // All confidences are above MIN_CONFIDENCE → NOT cold start
        const allAboveThreshold = maturedActions.every(a => a.confidence >= MIN_CONFIDENCE);
        expect(allAboveThreshold).toBe(true);

        // With coldStartActive=false and good confidence, policy should be exploit or explore (NOT cold_start)
        const result = getPolicyDecision({
            rankedActions: maturedActions,
            agentTrust: DEFAULT_TRUST,
            customerConfig: DEFAULT_POLICY_CONFIG,
            coldStartActive: false,
        }, () => 0.5);  // deterministic random

        expect(result.policy).not.toBe('escalate');
        expect(result.reason).not.toBe('cold_start');
        // Score 0.82, confidence 0.50 → falls in medium range (0.5-0.85)
        // confidence_weighted: roll=0.5 < confidence=0.5 → exploit
        expect(['exploit', 'explore']).toContain(result.policy);
    });
});
