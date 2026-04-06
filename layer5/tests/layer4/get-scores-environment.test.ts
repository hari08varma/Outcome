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
    const prevShadowFlag = process.env.LI_FEATURE_SIMULATION_SHADOW_V1;
    const prevShadowBlendUntil = process.env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES;
    const prevExploitGateFlag = process.env.LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1;
    const prevExploitGateSamples = process.env.LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES;

    beforeEach(() => {
        vi.clearAllMocks();
        if (prevShadowFlag === undefined) delete process.env.LI_FEATURE_SIMULATION_SHADOW_V1;
        else process.env.LI_FEATURE_SIMULATION_SHADOW_V1 = prevShadowFlag;

        if (prevShadowBlendUntil === undefined) delete process.env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES;
        else process.env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES = prevShadowBlendUntil;

        if (prevExploitGateFlag === undefined) delete process.env.LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1;
        else process.env.LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1 = prevExploitGateFlag;

        if (prevExploitGateSamples === undefined) delete process.env.LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES;
        else process.env.LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES = prevExploitGateSamples;
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

    it('applies simulation shadow blending to runtime ranking before policy evaluation', async () => {
        process.env.LI_FEATURE_SIMULATION_SHADOW_V1 = 'true';
        process.env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES = '80';

        const topAction = {
            action_id: 'action-1',
            action_name: 'restart_service',
            action_category: 'ops',
            composite_score: 0.75,
            confidence: 0.86,
            trend_delta: 0,
            trend: 'stable',
            total_attempts: 25,
            is_cold_start: false,
            is_low_sample: false,
            recommendation: 'recommend' as const,
        };
        const secondAction = {
            action_id: 'action-2',
            action_name: 'rollback_migration',
            action_category: 'ops',
            composite_score: 0.7,
            confidence: 0.62,
            trend_delta: 0,
            trend: 'stable',
            total_attempts: 5,
            is_cold_start: false,
            is_low_sample: false,
            recommendation: 'neutral' as const,
        };

        vi.mocked(getScores).mockResolvedValue({
            ranked_actions: [topAction, secondAction],
            top_action: topAction,
            should_escalate: false,
            cold_start: false,
            context_id: 'ctx-shadow',
            customer_id: 'cust-1',
            view_refreshed_at: new Date().toISOString(),
            served_from_cache: false,
        });

        const trustChain = makeThenableQuery({
            data: { trust_score: 0.8, trust_status: 'trusted', consecutive_failures: 0 },
            error: null,
        });
        const customerChain = makeThenableQuery({ data: { config: {} }, error: null });
        const contextChain = makeThenableQuery({ data: { context_id: 'ctx-shadow' }, error: null });
        const mvCountChain = makeThenableQuery({ count: 1, error: null });
        const decisionsChain = makeThenableQuery({
            data: [{ id: 'dec-1' }],
            error: null,
        });
        const counterfactualsChain = makeThenableQuery({
            data: [{
                unchosen_action_id: 'action-2',
                counterfactual_est: 0.99,
                ips_weight: 0.9,
                created_at: new Date().toISOString(),
            }],
            error: null,
        });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'agent_trust_scores') return trustChain as any;
            if (table === 'dim_customers') return customerChain as any;
            if (table === 'dim_contexts') return contextChain as any;
            if (table === 'mv_action_scores') return mvCountChain as any;
            if (table === 'fact_decisions') return decisionsChain as any;
            if (table === 'fact_outcome_counterfactuals') return counterfactualsChain as any;
            throw new Error(`Unexpected table: ${table}`);
        });

        const app = createApp();
        const res = await app.request('/v1/get-scores?issue_type=payment_failed&environment=production');
        const json = await res.json() as any;

        expect(res.status).toBe(200);
        expect(json.top_action?.action_id).toBe('action-2');
        expect(json.ranked_actions?.[0]?.action_id).toBe('action-2');
        expect(json.runtime_guardrail?.shadow_applied).toBe(true);
        expect(json.runtime_guardrail?.assisted_actions).toBe(1);
        expect(json.runtime_guardrail?.top_action_shadow_weight).toBeGreaterThan(0);
    });

    it('downgrades exploit policy to explore when runtime exploit gate is active for low-sample top action', async () => {
        process.env.LI_FEATURE_SIMULATION_SHADOW_V1 = 'true';
        process.env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES = '80';
        process.env.LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1 = 'true';
        process.env.LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES = '30';

        const topAction = {
            action_id: 'action-1',
            action_name: 'restart_service',
            action_category: 'ops',
            composite_score: 0.93,
            confidence: 0.88,
            trend_delta: 0,
            trend: 'stable',
            total_attempts: 12,
            is_cold_start: false,
            is_low_sample: false,
            recommendation: 'recommend' as const,
        };
        const secondAction = {
            action_id: 'action-2',
            action_name: 'rollback_migration',
            action_category: 'ops',
            composite_score: 0.81,
            confidence: 0.62,
            trend_delta: 0,
            trend: 'stable',
            total_attempts: 40,
            is_cold_start: false,
            is_low_sample: false,
            recommendation: 'neutral' as const,
        };

        vi.mocked(getScores).mockResolvedValue({
            ranked_actions: [topAction, secondAction],
            top_action: topAction,
            should_escalate: false,
            cold_start: false,
            context_id: 'ctx-guard',
            customer_id: 'cust-1',
            view_refreshed_at: new Date().toISOString(),
            served_from_cache: false,
        });

        const trustChain = makeThenableQuery({
            data: { trust_score: 0.8, trust_status: 'trusted', consecutive_failures: 0 },
            error: null,
        });
        const customerChain = makeThenableQuery({ data: { config: {} }, error: null });
        const contextChain = makeThenableQuery({ data: { context_id: 'ctx-guard' }, error: null });
        const mvCountChain = makeThenableQuery({ count: 1, error: null });
        const decisionsChain = makeThenableQuery({
            data: [{ id: 'dec-1' }],
            error: null,
        });
        const counterfactualsChain = makeThenableQuery({
            data: [{
                unchosen_action_id: 'action-1',
                counterfactual_est: 0.95,
                ips_weight: 0.9,
                created_at: new Date().toISOString(),
            }],
            error: null,
        });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'agent_trust_scores') return trustChain as any;
            if (table === 'dim_customers') return customerChain as any;
            if (table === 'dim_contexts') return contextChain as any;
            if (table === 'mv_action_scores') return mvCountChain as any;
            if (table === 'fact_decisions') return decisionsChain as any;
            if (table === 'fact_outcome_counterfactuals') return counterfactualsChain as any;
            throw new Error(`Unexpected table: ${table}`);
        });

        const app = createApp();
        const res = await app.request('/v1/get-scores?issue_type=payment_failed&environment=production');
        const json = await res.json() as any;

        expect(res.status).toBe(200);
        expect(json.policy).toBe('explore');
        expect(json.policy_reason).toBe('runtime_simulation_exploit_gate');
        expect(json.policy_selected_action).toBeNull();
        expect(json.policy_exploration_target).toBe('action-2');
        expect(json.runtime_guardrail?.shadow_applied).toBe(true);
        expect(json.runtime_guardrail?.top_action_shadow_weight).toBeGreaterThan(0);
        expect(json.runtime_guardrail?.exploit_gate_applied).toBe(true);
    });
});
