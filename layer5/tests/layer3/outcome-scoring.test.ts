/**
 * Layerinfinite — Unit Tests: 3-Tier Outcome Scoring
 * Tests computeEffectiveScore logic and outcome scoring routes.
 * Run: npm test (from api/)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mock supabase (hoisted — factory must not reference outer vars) ──
vi.mock('../../api/lib/supabase.js', () => {
    const chain: any = {};
    const methods = ['select', 'eq', 'order', 'insert', 'update', 'upsert', 'maybeSingle', 'single'];
    for (const m of methods) {
        chain[m] = vi.fn().mockReturnValue(chain);
    }
    return {
        supabase: {
            from: vi.fn().mockReturnValue(chain),
            _chain: chain,
        },
    };
});

// Mock scoring cache functions used by routes
vi.mock('../../api/lib/scoring.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../api/lib/scoring.js')>();
    return {
        ...actual,
        invalidateCache: vi.fn(),
        getCachedScore: vi.fn().mockReturnValue(null),
        getScores: vi.fn().mockResolvedValue({ ranked_actions: [], cold_start: true }),
    };
});

// Mock context-embed (used by scoring imports)
vi.mock('../../api/lib/context-embed.js', () => ({
    embedContext: vi.fn().mockResolvedValue([0.1, 0.2]),
}));

// Mock policy engine (used by log-outcome)
vi.mock('../../api/lib/policy-engine.js', () => ({
    getPolicyDecision: vi.fn().mockReturnValue({ decision: 'allow', actions: [] }),
    getAgentTrust: vi.fn().mockResolvedValue({ trust_score: 0.8, status: 'active' }),
    getCustomerConfig: vi.fn().mockResolvedValue({}),
    updateAgentTrust: vi.fn().mockResolvedValue(undefined),
}));

// Mock validate-action middleware — set validated_action + parsed_body
vi.mock('../../api/middleware/validate-action.js', () => ({
    validateActionMiddleware: vi.fn(async (c: any, next: any) => {
        const body = await c.req.json();
        c.set('validated_action', {
            action_id: 'act-001',
            action_name: body.action_name ?? 'restart_service',
            action_category: 'remediation',
        });
        c.set('parsed_body', body);
        await next();
    }),
    validateAction: vi.fn().mockResolvedValue({ valid: true, action_id: 'act-001' }),
}));

import { supabase } from '../../api/lib/supabase.js';
import { computeEffectiveScore } from '../../api/lib/scoring.js';
import { logOutcomeRouter } from '../../api/routes/log-outcome.js';
import { outcomeFeedbackRouter } from '../../api/routes/outcome-feedback.js';
import { validateActionMiddleware } from '../../api/middleware/validate-action.js';

function getChain() {
    return (supabase as any)._chain;
}

/** Build a fresh chain mock for one supabase.from() call */
function buildChain() {
    const c: any = {};
    for (const m of ['select', 'eq', 'order', 'insert', 'update', 'upsert', 'maybeSingle', 'single']) {
        c[m] = vi.fn().mockReturnValue(c);
    }
    return c;
}

// ── Helper: create test app for log-outcome ──────────────────
function createLogOutcomeApp() {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('agent_id', 'agent-test');
        c.set('customer_id', 'cust-test');
        await next();
    });
    app.use('/log-outcome/*', validateActionMiddleware);
    app.route('/log-outcome', logOutcomeRouter);
    return app;
}

// ── Helper: create test app for outcome-feedback ─────────────
function createFeedbackApp(customerId = 'cust-test') {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('customer_id', customerId);
        await next();
    });
    app.route('/feedback', outcomeFeedbackRouter);
    return app;
}

// ══════════════════════════════════════════════════════════════
// Pure function tests — computeEffectiveScore
// ══════════════════════════════════════════════════════════════

describe('computeEffectiveScore — pure logic', () => {
    it('success=true, no outcome_score → 1.0', () => {
        expect(computeEffectiveScore(true, undefined)).toBe(1.0);
    });

    it('success=false, no outcome_score → 0.0', () => {
        expect(computeEffectiveScore(false, undefined)).toBe(0.0);
    });

    it('success=true, outcome_score=0.3 → 0.3 (partial success)', () => {
        expect(computeEffectiveScore(true, 0.3)).toBe(0.3);
    });

    it('success=false, outcome_score=0.7 → 0.7 (partial recovery)', () => {
        expect(computeEffectiveScore(false, 0.7)).toBe(0.7);
    });
});

// ══════════════════════════════════════════════════════════════
// Route tests — POST /v1/log-outcome with outcome scoring
// ══════════════════════════════════════════════════════════════

describe('POST /v1/log-outcome — outcome scoring', () => {
    const validBody = {
        session_id: '11111111-1111-4111-a111-111111111111',
        action_name: 'restart_service',
        issue_type: 'cpu_spike',
        success: true,
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('with outcome_score=0.7 stores 0.7 in insert', async () => {
        // Two from() calls: dim_contexts lookup, fact_outcomes insert
        const ctxChain = buildChain();
        ctxChain.maybeSingle.mockResolvedValue({
            data: { context_id: 'ctx-1' },
            error: null,
        });

        const insertChain = buildChain();
        insertChain.single.mockResolvedValue({
            data: { outcome_id: 'out-1', timestamp: '2026-01-01' },
            error: null,
        });

        let callIdx = 0;
        vi.mocked(supabase.from).mockImplementation(() => {
            callIdx++;
            return (callIdx === 1 ? ctxChain : insertChain) as any;
        });

        const app = createLogOutcomeApp();
        const res = await app.fetch(
            new Request('http://localhost/log-outcome', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...validBody, outcome_score: 0.7 }),
            })
        );

        expect(res.status).toBe(201);

        // Verify insert was called with outcome_score
        const insertCall = insertChain.insert.mock.calls[0];
        expect(insertCall).toBeDefined();
        expect(insertCall[0].outcome_score).toBe(0.7);
    });

    it('without outcome_score falls back to null in insert', async () => {
        const ctxChain = buildChain();
        ctxChain.maybeSingle.mockResolvedValue({
            data: { context_id: 'ctx-1' },
            error: null,
        });

        const insertChain = buildChain();
        insertChain.single.mockResolvedValue({
            data: { outcome_id: 'out-2', timestamp: '2026-01-01' },
            error: null,
        });

        let callIdx = 0;
        vi.mocked(supabase.from).mockImplementation(() => {
            callIdx++;
            return (callIdx === 1 ? ctxChain : insertChain) as any;
        });

        const app = createLogOutcomeApp();
        const res = await app.fetch(
            new Request('http://localhost/log-outcome', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(validBody),
            })
        );

        expect(res.status).toBe(201);

        // outcome_score should be null (not provided)
        const insertCall = insertChain.insert.mock.calls[0];
        expect(insertCall).toBeDefined();
        expect(insertCall[0].outcome_score).toBeNull();
    });

    it('outcome_score=1.5 returns 400 validation error', async () => {
        const app = createLogOutcomeApp();
        const res = await app.fetch(
            new Request('http://localhost/log-outcome', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...validBody, outcome_score: 1.5 }),
            })
        );

        expect(res.status).toBe(400);
        const json = await res.json() as any;
        expect(json.code).toBe('VALIDATION_ERROR');
    });
});

// ══════════════════════════════════════════════════════════════
// Route tests — POST /v1/outcome-feedback
// ══════════════════════════════════════════════════════════════

describe('POST /v1/outcome-feedback', () => {
    const feedbackBody = {
        outcome_id: '22222222-2222-4222-a222-222222222222',
        final_score: 0.85,
        business_outcome: 'resolved' as const,
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('updates outcome_score correctly', async () => {
        // Three from() calls: lookup, insert feedback, update outcome
        const lookupChain = buildChain();
        lookupChain.maybeSingle.mockResolvedValue({
            data: { outcome_id: feedbackBody.outcome_id, customer_id: 'cust-test', context_id: 'ctx-1' },
            error: null,
        });

        const insertChain = buildChain();
        insertChain.insert.mockResolvedValue({ data: null, error: null });

        const updateChain = buildChain();
        updateChain.eq.mockResolvedValue({ data: null, error: null });

        let callIdx = 0;
        vi.mocked(supabase.from).mockImplementation(() => {
            callIdx++;
            if (callIdx === 1) return lookupChain as any;
            if (callIdx === 2) return insertChain as any;
            return updateChain as any;
        });

        const app = createFeedbackApp('cust-test');
        const res = await app.fetch(
            new Request('http://localhost/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(feedbackBody),
            })
        );

        expect(res.status).toBe(200);
        const json = await res.json() as any;
        expect(json.updated).toBe(true);
        expect(json.final_score).toBe(0.85);
        expect(json.business_outcome).toBe('resolved');
    });

    it('wrong customer_id returns 404 (not found)', async () => {
        // Lookup returns outcome belonging to a DIFFERENT customer
        const lookupChain = buildChain();
        lookupChain.maybeSingle.mockResolvedValue({
            data: { outcome_id: feedbackBody.outcome_id, customer_id: 'cust-OTHER', context_id: 'ctx-1' },
            error: null,
        });

        vi.mocked(supabase.from).mockReturnValue(lookupChain as any);

        const app = createFeedbackApp('cust-test');
        const res = await app.fetch(
            new Request('http://localhost/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(feedbackBody),
            })
        );

        expect(res.status).toBe(404);
        const json = await res.json() as any;
        expect(json.code).toBe('NOT_FOUND');
    });
});
