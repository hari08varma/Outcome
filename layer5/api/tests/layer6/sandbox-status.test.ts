import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../../lib/supabase.js';
import { getPolicyDecision } from '../../lib/policy-engine.js';
import { reinstateSandboxRouter } from '../../routes/admin/reinstate-sandbox.js';
import { orchestrateOutcome } from '../../lib/outcome-orchestrator.js';

vi.mock('../../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
        rpc: vi.fn(),
    }
}));

// Partially mock dependencies for updateAgentTrust in log-outcome
vi.mock('../../lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
    getCachedScore: vi.fn(() => null),
    getScores: vi.fn().mockResolvedValue({ ranked_actions: [], cold_start: false })
}));

describe('Graduated Sandbox Trust Pipeline', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('agent drops to sandbox (not suspended) at 5 failures', async () => {
        const makeQuery = (result: { data: any; error: any }) => {
            const q: any = {};
            q.select = vi.fn(() => q);
            q.eq = vi.fn(() => q);
            q.gte = vi.fn(() => q);
            q.ilike = vi.fn(() => q);
            q.order = vi.fn(() => q);
            q.limit = vi.fn(() => q);
            q.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
            q.insert = vi.fn(async () => ({ error: null }));
            q.update = vi.fn(() => q);
            q.upsert = vi.fn(async () => ({ error: null }));
            q.then = (resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(result).then(resolve, reject);
            return q;
        };

        const trustRow = {
            trust_id: 't-1',
            trust_score: 0.35,
            total_decisions: 10,
            correct_decisions: 6,
            consecutive_failures: 4,
            trust_status: 'probation',
        };

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'agent_trust_scores') {
                return {
                    select: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            maybeSingle: vi.fn(async () => ({ data: trustRow, error: null })),
                        })),
                    })),
                    update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
                    upsert: vi.fn(async () => ({ error: null })),
                };
            }
            if (table === 'fact_outcomes') return makeQuery({ data: [], error: null });
            if (table === 'degradation_alert_events') return makeQuery({ data: [], error: null });
            if (table === 'dim_contexts') {
                return {
                    select: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: vi.fn(() => ({
                                    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                                })),
                            })),
                        })),
                    })),
                };
            }
            if (table === 'agent_trust_snapshots') {
                return { insert: vi.fn(async () => ({ error: null })) };
            }
            return makeQuery({ data: null, error: null });
        });

        (supabase.rpc as any).mockImplementation(async (fn: string, args: any) => {
            if (fn === 'detect_coordinated_failures') return { data: [], error: null };
            if (fn === 'update_trust_and_audit') return { data: null, error: null };
            return { data: null, error: null };
        });

        await orchestrateOutcome({
            agentId: 'agent-1',
            customerId: 'customer-1',
            outcomeId: 'outcome-1',
            actionId: 'action-1',
            actionName: 'test_action',
            contextId: 'context-1',
            issueType: 'bug',
            finalSuccess: false,
            finalOutcomeScore: null,
        });

        const rpcArgs = (supabase.rpc as any).mock.calls
            .find((call: any[]) => call[0] === 'update_trust_and_audit')?.[1];

        expect(rpcArgs).toBeDefined();
        expect(rpcArgs.p_trust_status).toBe('sandbox');
        expect(rpcArgs.p_consecutive_failures).toBe(5);
        expect(rpcArgs.p_trust_score).toBeLessThan(0.35);
    });

    it('sandbox policy returns SANDBOX with human_review_required', () => {
        const agentTrust = {
            trust_score: 0.2,
            trust_status: 'sandbox' as const,
            consecutive_failures: 5
        };

        const result = getPolicyDecision({
            rankedActions: [{
                action_id: 'a-1',
                action_name: 'test_action',
                action_category: 'test',
                composite_score: 0.8,
                confidence: 0.9,
                trend_delta: 0,
                trend: 'stable' as const,
                total_attempts: 10,
                is_cold_start: false,
                is_low_sample: false,
                recommendation: 'recommend' as const,
            }],
            agentTrust,
            customerConfig: { risk_tolerance: 'balanced', min_confidence: 0.3, exploration_rate: 0.05, escalation_score: 0.2 },
            coldStartActive: false
        });

        expect(result.policy).toBe('SANDBOX');
        expect(result.human_review_required).toBe(true);
        expect(result.selectedAction).toBe('a-1'); // STILL provides highest action guidance
    });

    it('POST /sandbox-reinstate moves suspended agent to sandbox', async () => {
        const updateMockFn = vi.fn().mockReturnThis();
        const chainedEq = vi.fn().mockResolvedValue({ error: null });

        const fromMock = vi.fn((table: string) => {
            if (table === 'agent_trust_scores') {
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({
                        data: { trust_status: 'suspended', customer_id: 'c-1' },
                        error: null
                    }),
                    update: updateMockFn.mockReturnValue({ eq: chainedEq })
                };
            }
            if (table === 'agent_trust_audit') {
                return { insert: vi.fn().mockResolvedValue({ error: null }) };
            }
            return {} as any;
        });

        (supabase.from as any).mockImplementation(fromMock);

        const req = {
            method: 'POST',
            url: 'http://localhost/v1/admin/agents/agent-1/sandbox-reinstate',
            param: (p: string) => p === 'agent_id' ? 'agent-1' : null,
            json: async () => ({ reason: 'manual review passed' })
        } as unknown as Request;

        const c = {
            req,
            json: (data: any, status: number) => ({ data, status }),
        } as any;

        const handler = reinstateSandboxRouter.routes.find((r: any) => r.method === 'POST')?.handler as Function;
        const res = await handler(c, vi.fn());

        expect(res.status).toBe(200);

        expect(updateMockFn).toHaveBeenCalled();
        const updatePayload = updateMockFn.mock.calls[0][0];

        expect(updatePayload.trust_status).toBe('sandbox');
        expect(updatePayload.trust_score).toBe(0.15); // baseline boost
        expect(updatePayload.consecutive_failures).toBe(0);
    });
});
