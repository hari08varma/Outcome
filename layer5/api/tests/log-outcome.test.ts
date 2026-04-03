import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
        rpc: vi.fn(),
    },
}));

vi.mock('../lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
    getCachedScore: vi.fn(() => null),
    getScores: vi.fn().mockResolvedValue({
        ranked_actions: [],
        top_action: null,
        cold_start: true,
    }),
}));

vi.mock('../lib/outcome-orchestrator.js', () => ({
    orchestrateOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/verifier.js', () => ({
    resolveVerifiedSuccess: vi.fn(() => ({
        verified_success: true,
        confidence_override: null,
        discrepancy_detected: false,
    })),
}));

import { supabase } from '../lib/supabase.js';
import { logOutcomeRouter, parseAndSanitizeRequest } from '../routes/log-outcome.js';

function createLogOutcomeApp(): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
        c.set('agent_id' as any, 'agent-test');
        c.set('customer_id' as any, 'customer-test');
        await next();
    });

    app.route('/v1/log-outcome', logOutcomeRouter);
    return app;
}

describe('POST /v1/log-outcome smoke tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('Validation rejects missing issue_type', async () => {
        const app = createLogOutcomeApp();

        const res = await app.request('/v1/log-outcome', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action_name: 'test', success: true }),
        });

        expect(res.status).toBe(400);

        const json = await res.json() as any;
        expect(json.code).toBe('VALIDATION_ERROR');
    });

    it('response_ms alias maps to response_time_ms in parseAndSanitizeRequest', async () => {
        const body = {
            issue_type: 'test',
            action_name: 'test',
            success: true,
            response_ms: 250,
        };

        const parsed = await parseAndSanitizeRequest({
            get: (key: string) => (key === 'parsed_body' ? body : undefined),
            req: {
                json: async () => body,
            },
        } as any);

        expect(parsed.response_time_ms).toBe(250);
    });

    it('Payload size guard rejects raw_context > 64KB', async () => {
        const app = createLogOutcomeApp();

        const res = await app.request('/v1/log-outcome', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                issue_type: 'test',
                action_name: 'test',
                success: true,
                raw_context: {
                    oversized: 'x'.repeat(70 * 1024),
                },
            }),
        });

        expect(res.status).toBe(413);

        const json = await res.json() as any;
        expect(json.error).toBe('PAYLOAD_TOO_LARGE');
    });

    it('idempotency_key replay returns 200 with idempotency_replayed=true', async () => {
        const idempotencyChain: any = {};
        idempotencyChain.select = vi.fn().mockReturnValue(idempotencyChain);
        idempotencyChain.eq = vi.fn().mockReturnValue(idempotencyChain);
        idempotencyChain.maybeSingle = vi.fn().mockResolvedValue({
            data: { outcome_id: 'outcome-123' },
            error: null,
        });

        const outcomesChain: any = {};
        outcomesChain.select = vi.fn().mockReturnValue(outcomesChain);
        outcomesChain.eq = vi.fn().mockReturnValue(outcomesChain);
        outcomesChain.single = vi.fn().mockResolvedValue({
            data: {
                outcome_id: 'outcome-123',
                action_id: 'action-abc',
                context_id: 'context-xyz',
                timestamp: new Date().toISOString(),
                success: true,
            },
            error: null,
        });

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'fact_outcome_idempotency') return idempotencyChain;
            if (table === 'fact_outcomes') return outcomesChain;
            throw new Error(`Unexpected table in idempotency test: ${table}`);
        });

        const app = createLogOutcomeApp();

        const res = await app.request('/v1/log-outcome', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                issue_type: 'test',
                action_name: 'test',
                success: true,
                idempotency_key: 'idem-123',
            }),
        });

        expect(res.status).toBe(200);

        const json = await res.json() as any;
        expect(json.idempotency_replayed).toBe(true);
    });
});
