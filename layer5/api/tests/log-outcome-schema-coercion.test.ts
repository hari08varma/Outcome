/**
 * Tests for SDK schema coercion in log-outcome route.
 * Verifies that the Zod schema correctly handles:
 *   - outcome_score percentage auto-detection (85 → 0.85)
 *   - response_time_ms string coercion ("250" → 250)
 *   - success string/number coercion ("true" → true, 1 → true)
 *   - resource_cost_units/type acceptance
 *   - Rejection of invalid values with field-level errors
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock supabase before importing route module
vi.mock('../lib/supabase.js', () => ({
    supabase: { from: vi.fn() },
}));

// Mock scoring module
vi.mock('../lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
    getCachedScore: vi.fn().mockReturnValue(null),
    getScores: vi.fn(),
}));

// Mock outcome orchestrator
vi.mock('../lib/outcome-orchestrator.js', () => ({
    orchestrateOutcome: vi.fn().mockResolvedValue(undefined),
}));

// Mock outcome score inference
vi.mock('../lib/outcome-score-inference.js', () => ({
    inferOutcomeScore: vi.fn().mockReturnValue({ score: 0.5, confidence: 0.5, class: 'neutral' }),
    fetchActionBaseline: vi.fn().mockResolvedValue(null),
    invalidateActionBaselineCache: vi.fn(),
}));

import { parseAndSanitizeRequest } from '../routes/log-outcome.js';

function makeContext(body: Record<string, unknown>): any {
    return {
        get: (key: string) => {
            if (key === 'parsed_body') return body;
            return undefined;
        },
        req: {
            json: () => Promise.resolve(body),
        },
    };
}

describe('SDK Schema Coercion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── outcome_score percentage coercion ──────────────────────

    it('outcome_score: 85 → coerced to 0.85', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            outcome_score: 85,
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.outcome_score).toBeCloseTo(0.85, 4);
    });

    it('outcome_score: 100 → coerced to 1.0', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            outcome_score: 100,
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.outcome_score).toBeCloseTo(1.0, 4);
    });

    it('outcome_score: 0.75 → stays 0.75 (no coercion needed)', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            outcome_score: 0.75,
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.outcome_score).toBeCloseTo(0.75, 4);
    });

    it('outcome_score: 0 → stays 0.0', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: false,
            outcome_score: 0,
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.outcome_score).toBe(0);
    });

    it('outcome_score: "high" → rejected with VALIDATION_ERROR', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            outcome_score: 'high',
        });
        await expect(parseAndSanitizeRequest(c)).rejects.toThrow('VALIDATION_ERROR');
    });

    it('outcome_score: 150 → rejected (>100 after coercion still >1.0)', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            outcome_score: 150,
        });
        // 150 > 1 and <= 100 is false, so no coercion; 150 fails max(1.0)
        await expect(parseAndSanitizeRequest(c)).rejects.toThrow('VALIDATION_ERROR');
    });

    // ── response_time_ms string coercion ──────────────────────

    it('response_time_ms: "250" → coerced to 250', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            response_time_ms: '250',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.response_time_ms).toBe(250);
    });

    it('response_time_ms: "abc" → null (gracefully dropped)', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            response_time_ms: 'abc',
        });
        const body = await parseAndSanitizeRequest(c);
        // Zod coercion drops invalid string to undefined, then
        // parseAndSanitizeRequest maps undefined → null at line 475.
        expect(body.response_time_ms).toBeNull();
    });

    it('response_time_ms/response_ms: 0 → null (gracefully dropped)', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            response_time_ms: 0,
            response_ms: 0,
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.response_time_ms).toBeNull();
    });

    // ── success coercion ──────────────────────────────────────

    it('success: "true" → coerced to true', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: 'true',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.success).toBe(true);
    });

    it('success: "false" → coerced to false', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: 'false',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.success).toBe(false);
    });

    it('success: 1 → coerced to true', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: 1,
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.success).toBe(true);
    });

    it('success: "resolved" → coerced to true', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: 'resolved',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.success).toBe(true);
    });

    // ── environment normalization (regression test) ───────────

    it('environment: "prod" → normalized to "production"', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            environment: 'prod',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.environment).toBe('production');
    });

    it('environment: "stg" → normalized to "staging"', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            environment: 'stg',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.environment).toBe('staging');
    });

    // ── resource cost fields ─────────────────────────────────

    it('accepts resource_cost_units and resource_cost_type', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            resource_cost_units: 450,
            resource_cost_type: 'tokens',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.resource_cost_units).toBe(450);
        expect(body.resource_cost_type).toBe('tokens');
    });

    it('resource_cost_units: "300" → coerced to 300', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            resource_cost_units: '300',
        });
        const body = await parseAndSanitizeRequest(c);
        expect(body.resource_cost_units).toBe(300);
    });

    it('resource_cost_type: invalid → rejected', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            resource_cost_type: 'invalid_type',
        });
        await expect(parseAndSanitizeRequest(c)).rejects.toThrow('VALIDATION_ERROR');
    });
});
