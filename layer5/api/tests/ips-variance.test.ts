import { expect, test, describe } from 'vitest';
import { computeCompositeScore } from '../lib/scoring.js';
import { computeIPSEstimate, IPS_WEIGHT_CAP } from '../lib/ips-engine.js';
import { ActionScore } from '../lib/supabase.js';

describe('IPS Engine & Scoring Bayesian Variance', () => {

    test('Test 1: action with n=0 scores at 0.5, not 0.0', () => {
        // Mock mv_action_scores row with literally zero observations
        const row: ActionScore = {
            action_id: 'action-1',
            action_name: 'test_action',
            action_category: 'test',
            total_attempts: 0,
            weighted_success_rate: 0,
            raw_success_rate: 0,
            confidence: 0,
            trend_delta: null,
            last_outcome_at: null
        } as any;

        const score = computeCompositeScore(row);

        // Prior pulls 0% success toward 50% when n=0
        // Expected Bayesian rate: (0 * 0 + 1) / (0 + 1 + 1) = 0.5
        // W_SUCCESS(0.4) * 0.5 + W_TREND(0.2) * 0.5 + W_SALIENCE(0.1) * 1.0 + W_RECENCY(0.1) * 0.5 = 0.45
        expect(score).toBeCloseTo(0.45, 1);
        expect(score).toBeGreaterThan(0.4); // Confirms the smoothing pulled it up securely away from 0.0
    });

    test('Test 2: action with n=1 and success=1.0 doesn\'t score 1.0', () => {
        // Mock row representing first-success outlier mapping
        const row: ActionScore = {
            action_id: 'action-2',
            action_name: 'test_action_2',
            total_attempts: 1,
            weighted_success_rate: 1.0,
            raw_success_rate: 1.0,
            confidence: 0.09, // Wilson confidence n=1: 1/(1+10) = 0.09
            trend_delta: null,
            last_outcome_at: null
        } as any;

        const score = computeCompositeScore(row);

        // Expected Bayesian rate: (1*1 + 1) / (1 + 1 + 1) = 0.667.
        // It should rigorously dampen the composite bounding it downward away from complete confidence.
        expect(score).toBeLessThan(0.80);
        expect(score).toBeGreaterThan(0.0);
    });

    test('Test 3: IPS propensity ratio is capped at 5.0', () => {
        const result = computeIPSEstimate(
            1.0,   // realOutcome
            0.01,  // propensityChosen (extremely low!)
            0.90   // propensityUnchosen (extremely high!)
        );

        // Unbounded ratio would exceed 90x propensity variance.
        // The clipping bounds ratio at 5x maximum.
        // We assert mathematical sanity across boundaries natively.
        expect(result.estimate).toBeLessThanOrEqual(1.0);
        expect(result.weight).toBeLessThanOrEqual(IPS_WEIGHT_CAP);
        expect(result.estimate).toBeGreaterThan(0.0);
    });

});
