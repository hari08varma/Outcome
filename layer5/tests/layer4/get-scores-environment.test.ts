import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../api/lib/scoring.js', () => ({
    getScores: vi.fn(),
}));

vi.mock('../../api/lib/decision-writer.js', () => ({
    bufferDecision: vi.fn(() => null),
}));

vi.mock('../../api/lib/context-embed.js', () => ({
    generateEmbedding: vi.fn(),
    findClosestContext: vi.fn(),
    buildContextText: vi.fn((issueType: string, customerTier?: string, environment?: string) =>
        [issueType, customerTier, environment].filter(Boolean).join(' ')
    ),
}));

vi.mock('../../api/lib/policy-engine.js', () => ({
    DEFAULT_TRUST: {
        trust_score: 0.5,
        trust_status: 'probation',
        consecutive_failures: 0,
    },
    DEFAULT_POLICY_CONFIG: {
        risk_tolerance: 'balanced',
        escalation_score: 0.2,
        exploration_rate: 0.05,
        min_confidence: 0.3,
    },
    getPolicyDecision: vi.fn(() => ({
        policy: 'exploit',
        reason: 'test_policy',
        selectedAction: null,
        explorationTarget: null,
    })),
}));

vi.mock('../../api/lib/ips-engine.js', () => ({
    computePropensities: vi.fn((actions: Array<{ action_name: string }>) =>
        new Map(actions.map((a) => [a.action_name, 1]))
    ),
}));

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
        rpc: vi.fn(),
    },
}));

import { getScoresRouter } from '../../api/routes/get-scores.js';
import { supabase } from '../../api/lib/supabase.js';
import { getScores } from '../../api/lib/scoring.js';
import { findClosestContext, generateEmbedding } from '../../api/lib/context-embed.js';

function makeThenableQuery(result: any) {
    const q: any = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.neq = vi.fn(() => q);
    q.gte = vi.fn(() => q);
    q.in = vi.fn(() => q);
    q.order = vi.fn(() => q);
    q.limit = vi.fn(() => q);
    q.maybeSingle = vi.fn(async () => result);
    q.single = vi.fn(async () => result);
    q.then = (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
    return q;
}

function createApp() {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('customer_id', 'cust-1');
        c.set('agent_id', 'agent-1');
        await next();
    });
    app.route('/v1/get-scores', getScoresRouter);
    return app;
}

function mockScoringResult(contextId: string) {
    const topAction = {
        action_id: 'action-1',
        action_name: 'restart_service',
        action_category: 'ops',
        composite_score: 0.91,
        confidence: 0.87,
        trend_delta: 0,
        trend: 'stable',
        total_attempts: 24,
        is_cold_start: false,
        is_low_sample: false,
        recommendation: 'recommend' as const,
    };

    vi.mocked(getScores).mockResolvedValue({
        ranked_actions: [topAction],
        top_action: topAction,
        should_escalate: false,
        cold_start: false,
        context_id: contextId,
        customer_id: 'cust-1',
        view_refreshed_at: new Date().toISOString(),
        served_from_cache: false,
    });
}

describe('get-scores environment scoping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('normalizes environment alias and scopes exact context lookup', async () => {
        mockScoringResult('ctx-staging');

        const trustChain = makeThenableQuery({
            data: { trust_score: 0.8, trust_status: 'trusted', consecutive_failures: 0 },
            error: null,
        });
        const customerChain = makeThenableQuery({ data: { config: {} }, error: null });
        const contextChain = makeThenableQuery({ data: { context_id: 'ctx-staging' }, error: null });
        const mvCountChain = makeThenableQuery({ count: 1, error: null });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'agent_trust_scores') return trustChain as any;
            if (table === 'dim_customers') return customerChain as any;
            if (table === 'dim_contexts') return contextChain as any;
            if (table === 'mv_action_scores') return mvCountChain as any;
            throw new Error(`Unexpected table: ${table}`);
        });

        const app = createApp();
        const res = await app.request('/v1/get-scores?issue_type=payment_failed&environment=qa');
        const json = await res.json() as any;

        expect(res.status).toBe(200);
        expect(json.environment).toBe('staging');
        expect(contextChain.eq).toHaveBeenCalledWith('environment', 'staging');
        expect(findClosestContext).not.toHaveBeenCalled();
    });

    it('defaults unknown environment to production and passes it to embedding fallback', async () => {
        mockScoringResult('ctx-production');

        const trustChain = makeThenableQuery({
            data: { trust_score: 0.8, trust_status: 'trusted', consecutive_failures: 0 },
            error: null,
        });
        const customerChain = makeThenableQuery({ data: { config: {} }, error: null });
        const contextChain = makeThenableQuery({ data: null, error: null });
        const mvCountChain = makeThenableQuery({ count: 1, error: null });

        vi.mocked(generateEmbedding).mockResolvedValue([0.11, 0.22, 0.33]);
        vi.mocked(findClosestContext).mockResolvedValue({
            context_id: 'ctx-production',
            similarity: 0.88,
        });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'agent_trust_scores') return trustChain as any;
            if (table === 'dim_customers') return customerChain as any;
            if (table === 'dim_contexts') return contextChain as any;
            if (table === 'mv_action_scores') return mvCountChain as any;
            throw new Error(`Unexpected table: ${table}`);
        });

        const app = createApp();
        const res = await app.request('/v1/get-scores?issue_type=payment_failed&environment=unknown_env');
        const json = await res.json() as any;

        expect(res.status).toBe(200);
        expect(json.environment).toBe('production');
        expect(contextChain.eq).toHaveBeenCalledWith('environment', 'production');
        expect(findClosestContext).toHaveBeenCalledWith([0.11, 0.22, 0.33], 'cust-1', {
            environment: 'production',
        });
    });
});
