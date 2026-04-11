/**
 * Tests for predictive drift detection (linear regression).
 * Validates the regression algorithm and drift prediction logic.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock supabase to prevent env var requirement during module load
vi.mock('../../api/lib/supabase.js', () => ({
    supabase: { from: vi.fn() },
}));

import { linearRegression } from '../../api/lib/predictive-drift.js';

describe('Predictive Drift — Linear Regression', () => {
    it('detects negative slope in declining scores', () => {
        // Simulates an action that's steadily degrading
        const scores = [
            0.95, 0.93, 0.90, 0.88, 0.85,
            0.82, 0.80, 0.77, 0.75, 0.72,
            0.70, 0.67, 0.65, 0.62, 0.60,
            0.57, 0.55, 0.52, 0.50, 0.47,
        ];
        const result = linearRegression(scores);

        expect(result.slope).toBeLessThan(0);
        expect(result.r2).toBeGreaterThan(0.9); // strong linear fit
        expect(result.projectedScore).toBeLessThan(0.35); // projects below threshold
    });

    it('detects stable/positive slope in healthy scores', () => {
        const scores = [
            0.80, 0.82, 0.81, 0.83, 0.82,
            0.84, 0.83, 0.85, 0.84, 0.86,
            0.85, 0.87, 0.86, 0.88, 0.87,
            0.89, 0.88, 0.90, 0.89, 0.91,
        ];
        const result = linearRegression(scores);

        expect(result.slope).toBeGreaterThan(0);
        expect(result.projectedScore).toBeGreaterThan(0.8);
    });

    it('returns zero slope for constant scores', () => {
        const scores = Array(20).fill(0.75);
        const result = linearRegression(scores);

        expect(result.slope).toBe(0);
        expect(result.projectedScore).toBeCloseTo(0.75, 2);
        expect(result.r2).toBe(1); // perfect fit (no variance)
    });

    it('handles minimum 2 samples', () => {
        const result = linearRegression([0.8, 0.6]);

        expect(result.slope).toBeLessThan(0);
        expect(result.intercept).toBeCloseTo(0.8, 2);
    });

    it('handles single sample gracefully', () => {
        const result = linearRegression([0.5]);

        expect(result.slope).toBe(0);
        expect(result.projectedScore).toBe(0.5);
    });

    it('handles empty array', () => {
        const result = linearRegression([]);

        expect(result.slope).toBe(0);
        expect(result.projectedScore).toBe(0.5);
    });

    it('projects correctly with noisy but declining data', () => {
        // Noisy data with overall declining trend
        const scores = [
            0.90, 0.85, 0.88, 0.82, 0.86,
            0.80, 0.83, 0.78, 0.81, 0.75,
            0.78, 0.72, 0.76, 0.70, 0.73,
            0.68, 0.71, 0.65, 0.68, 0.62,
        ];
        const result = linearRegression(scores);

        expect(result.slope).toBeLessThan(0);
        expect(result.r2).toBeGreaterThan(0.5); // moderate fit with noise
        expect(result.projectedScore).toBeLessThan(0.6);
    });

    it('clamps projected score between 0 and 1', () => {
        // Extreme declining scores that would project below 0
        const scores = [
            0.50, 0.45, 0.40, 0.35, 0.30,
            0.25, 0.20, 0.15, 0.10, 0.05,
            0.04, 0.03, 0.02, 0.01, 0.01,
            0.01, 0.01, 0.01, 0.01, 0.01,
        ];
        const result = linearRegression(scores);

        expect(result.projectedScore).toBeGreaterThanOrEqual(0);
        expect(result.projectedScore).toBeLessThanOrEqual(1);
    });
});
