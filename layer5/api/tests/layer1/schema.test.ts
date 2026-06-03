import { describe, test, expect, vi } from 'vitest';
import { Hono } from 'hono';
import crypto from 'node:crypto';

vi.mock('../../lib/supabase.js', () => ({
    supabase: {
        from: () => ({
            select: () => {
                const chain: any = {
                    eq: () => chain,
                    order: () => chain,
                    limit: () => chain,
                    maybeSingle: async () => ({ data: null, error: null }),
                    single: async () => ({ data: null, error: null })
                };
                return chain;
            },
            upsert: () => {
                const chain: any = {
                    select: () => chain,
                    single: async () => ({ data: { context_id: 'test-context-123' }, error: null }),
                    maybeSingle: async () => ({ data: { context_id: 'test-context-123' }, error: null })
                };
                return chain;
            },
            insert: () => {
                const chain: any = {
                    select: () => chain,
                    single: async () => ({ data: { outcome_id: 'test-id', context_id: 'test-context-123', timestamp: new Date().toISOString() }, error: null })
                };
                return chain;
            }
        }),
    },
}));

vi.mock('../../lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
    getCachedScore: vi.fn().mockReturnValue(null),
    getScores: vi.fn().mockResolvedValue({ ranked_actions: [], cold_start: false }),
}));

vi.mock('../../lib/policy-engine.js', () => ({
    getPolicyDecision: vi.fn().mockReturnValue(null),
    DEFAULT_TRUST: {},
    DEFAULT_POLICY_CONFIG: {},
}));

vi.mock('../../lib/outcome-orchestrator.js', () => ({
    orchestrateOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/sanitize.js', () => ({
    sanitizeContext: (x: any) => x,
    sanitizeString: (x: string) => x,
}));

vi.mock('../../lib/verifier.js', () => ({
    resolveVerifiedSuccess: () => ({
        verified_success: true,
        confidence_override: null,
        discrepancy_detected: false,
    }),
}));

vi.mock('../../lib/outcome-ingest-queue.js', () => ({
    getOutcomeQueueMode: () => 'sync',
    enqueueDurable: vi.fn(),
    OUTCOME_INGEST_WORKER_BYPASS_HEADER: 'x-li-worker-bypass',
}));

vi.mock('../../middleware/validate-action.js', () => ({
    validateAction: async () => ({
        valid: true,
        action_id: 'test-action-id',
    }),
    normalizeActionName: (x: string) => x,
}));

import { logOutcomeRouter } from '../../routes/log-outcome.js';

describe('Layer 1 — Schema validation', () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('agent_id', 'd0000000-0000-0000-0000-000000000001');
        c.set('customer_id', 'a0000000-0000-0000-0000-000000000001');
        await next();
    });
    app.route('/', logOutcomeRouter);

    test('accepts payload missing session_id (auto-generated)', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action_name: 'refund', issue_type: 'billing', success: true }),
        });
        expect(res.status).toBe(201);
    });

    test('rejects outcome_score above 1.0', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: crypto.randomUUID(), action_name: 'refund', issue_type: 'billing', success: true, outcome_score: 1.5 }),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.code).toBe('VALIDATION_ERROR');
    });

    test('rejects outcome_score below 0', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: crypto.randomUUID(), action_name: 'refund', issue_type: 'billing', success: true, outcome_score: -0.1 }),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.code).toBe('VALIDATION_ERROR');
    });

    test('normalizes unknown business_outcome value to unknown', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: crypto.randomUUID(), action_name: 'refund', issue_type: 'billing', success: true, business_outcome: 'winning' }),
        });
        expect(res.status).toBe(201);
    });

    test("normalizes environment alias 'qa' to 'staging' and returns 201", async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: crypto.randomUUID(), action_name: 'refund', issue_type: 'billing', success: true, environment: 'qa' }),
        });
        expect(res.status).toBe(201);
        const body = await res.json() as any;
        expect(body.idempotency_replayed).toBe(false);
    });

    test("normalizes unknown environment 'unknown_env' to 'production' and returns 201", async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: crypto.randomUUID(), action_name: 'refund', issue_type: 'billing', success: true, environment: 'unknown_env' }),
        });
        expect(res.status).toBe(201);
    });

    test('accepts valid minimal payload', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: crypto.randomUUID(),
                action_name: 'send_refund',
                issue_type: 'billing',
                success: true
            }),
        });
        const body = await res.json() as any;
        if (res.status !== 201) console.error('500 ERROR BODY:', body);
        expect(res.status).toBe(201);
        expect(body.outcome_id).toBeDefined();
    });

    test('rejects conflicting execution_status and success payload', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: crypto.randomUUID(),
                action_name: 'send_refund',
                issue_type: 'billing',
                success: true,
                execution_status: 'FAILED',
                failure_reason_code: 'execution_failed',
                failure_stage: 'action_execution',
            }),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.code).toBe('STATUS_CONFLICT');
    });

    test('rejects conflicting execution_status and outcome_score polarity payload', async () => {
        const res = await app.request('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: crypto.randomUUID(),
                action_name: 'send_refund',
                issue_type: 'billing',
                success: true,
                execution_status: 'COMPLETED',
                outcome_score: 0.2,
            }),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.code).toBe('STATUS_CONFLICT');
    });
});
