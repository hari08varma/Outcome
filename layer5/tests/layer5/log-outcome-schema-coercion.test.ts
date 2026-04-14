import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: { from: vi.fn() },
}));

vi.mock('../../api/lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
    getCachedScore: vi.fn().mockReturnValue(null),
    getScores: vi.fn(),
}));

vi.mock('../../api/lib/outcome-orchestrator.js', () => ({
    orchestrateOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/lib/outcome-score-inference.js', () => ({
    inferOutcomeScore: vi.fn().mockReturnValue({ score: 0.5, confidence: 0.5, class: 'neutral' }),
    fetchActionBaseline: vi.fn().mockResolvedValue(null),
    invalidateActionBaselineCache: vi.fn(),
}));

import { parseAndSanitizeRequest } from '../../api/routes/log-outcome.js';

function makeContext(body: Record<string, unknown>): any {
    return {
        get: (key: string) => (key === 'parsed_body' ? body : undefined),
        req: {
            json: () => Promise.resolve(body),
        },
    };
}

describe('log-outcome schema coercion (runtime tree)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('drops nonpositive response latency values instead of raising validation errors', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            response_time_ms: 0,
            response_ms: -1,
        });

        const body = await parseAndSanitizeRequest(c);
        expect(body.response_time_ms).toBeNull();
    });

    it('preserves positive response_ms alias values', async () => {
        const c = makeContext({
            action_name: 'retry_payment',
            issue_type: 'billing',
            success: true,
            response_ms: '120',
        });

        const body = await parseAndSanitizeRequest(c);
        expect(body.response_time_ms).toBe(120);
    });
});
