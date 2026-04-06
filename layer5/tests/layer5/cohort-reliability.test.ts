import { describe, expect, it } from 'vitest';

import { computeCohortReliability } from '../../api/lib/recommendation/cohort-reliability.js';
import type { RecommendationResult } from '../../api/lib/recommendation/engine.js';
import type { RecommendationCohortCycleResult } from '../../api/lib/recommendation/cohort-cycle.js';

function baseRecommendation(): RecommendationResult {
    return {
        task: 'payment_failed',
        state: 'stable',
        best_action: {
            action_id: 'a1',
            action_name: 'issue_refund',
            total_count: 30,
            effective_sample_count: 30,
            success_count: 25,
            success_rate: 0.83,
            resolution_rate: 0.82,
            ml_score: 0.8,
            last_seen_at: new Date().toISOString(),
        },
        worst_action: {
            action_id: 'a2',
            action_name: 'retry_payment',
            total_count: 30,
            effective_sample_count: 30,
            success_count: 16,
            success_rate: 0.53,
            resolution_rate: 0.51,
            ml_score: 0.5,
            last_seen_at: new Date().toISOString(),
        },
        confidence: 0.82,
        improvement: {
            baseline_rate: 0.51,
            improved_rate: 0.82,
            absolute_delta: 0.31,
            relative_delta: 0.6078,
        },
        min_sample_count: 30,
        all_actions: [],
        generated_at: new Date().toISOString(),
        agent_id: null,
        registered_actions: [],
        action_mismatch: false,
        _noise_gate: {
            enabled: true,
            is_noisy_task: false,
            task_noise_score: 0.05,
            best_action_win_rate: 0.82,
            absolute_gap: 0.31,
            effective_samples: 30,
            required_samples: 10,
            stable_samples: 25,
            high_confidence_samples: 50,
            decision_gate_reason: null,
        },
        _simulation_guardrail: {
            enabled: false,
            shadow_applied: false,
            assisted_actions: 0,
            top_action_shadow_weight: 0,
            confidence_ceiling_applied: false,
            exploit_gate_applied: false,
            confidence_ceiling: 0.75,
            exploit_gate_min_samples: 50,
        },
    } as RecommendationResult;
}

function baseCohortCycle(): RecommendationCohortCycleResult {
    return {
        active_cycle: {
            cycle_id: 'c1',
            opened_at: new Date().toISOString(),
            closed_at: null,
            close_reason: null,
            elapsed_days: 1,
            outcomes_in_cycle: 30,
        },
        previous_cycle: null,
        rotation_triggered: false,
        rotation_reason: null,
        thresholds: {
            max_days: 7,
            max_outcomes: 100,
            confidence_drop: 0.1,
            success_rate_drop: 0.15,
        },
    };
}

describe('cohort reliability scoring', () => {
    it('returns stable reliability for clean stable signals', () => {
        const reliability = computeCohortReliability(baseRecommendation(), baseCohortCycle());

        expect(reliability.band).toBe('stable');
        expect(reliability.reliability_score).toBeGreaterThan(0.7);
        expect(reliability.anomaly_score).toBeLessThan(0.3);
    });

    it('returns anomalous reliability for conflict-heavy inputs', () => {
        const recommendation = baseRecommendation();
        recommendation.state = 'early_signal';
        recommendation.confidence = 0.18;
        recommendation.min_sample_count = 4;
        recommendation._silent_failure_warning = true;
        recommendation._noise_gate = {
            ...(recommendation._noise_gate as NonNullable<RecommendationResult['_noise_gate']>),
            is_noisy_task: true,
            task_noise_score: 0.9,
            decision_gate_reason: 'noise_score_above_threshold',
        };

        const cohortCycle = baseCohortCycle();
        cohortCycle.rotation_triggered = true;
        cohortCycle.rotation_reason = 'confidence_drop';

        const reliability = computeCohortReliability(recommendation, cohortCycle);

        expect(reliability.band).toBe('anomalous');
        expect(reliability.anomaly_score).toBeGreaterThan(0.55);
        expect(reliability.reasons.length).toBeGreaterThan(0);
    });
});