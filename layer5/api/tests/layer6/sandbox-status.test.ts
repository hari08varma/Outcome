import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../../lib/supabase.js';
import { logOutcomeRouter } from '../../routes/log-outcome.js';
import { getPolicyDecision } from '../../lib/policy-engine.js';
import { reinstateSandboxRouter } from '../../routes/admin/reinstate-sandbox.js';

vi.mock('../../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn()
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
        const updateMock = vi.fn().mockResolvedValue({ error: null });
        const fromMock = vi.fn((table: string) => {
            if (table === 'agent_trust_scores') {
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({
                        data: {
                            trust_id: 't-1',
                            trust_score: 0.35,
                            total_decisions: 10,
                            correct_decisions: 6,
                            consecutive_failures: 4,
                            trust_status: 'probation'
                        }
                    }),
                    update: vi.fn().mockReturnThis(),
                };
            }
            // Mocks for fact_outcomes and agent_trust_audit
            return {
                insert: vi.fn().mockResolvedValue({
                    select: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: { outcome_id: 'mock-auth', timestamp: '2025' }
                        })
                    })
                }),
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: null })
            };
        });

        // Intercept the `update` command directly against supabase mock to detect status updates
        const mockedUpdateFn = vi.fn().mockReturnThis();
        const chainedEq = vi.fn().mockResolvedValue({ error: null });

        fromMock.mockImplementation((table) => {
            if (table === 'agent_trust_scores') {
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({
                        data: {
                            trust_id: 't-1',
                            trust_score: 0.35,
                            total_decisions: 10,
                            correct_decisions: 6,
                            consecutive_failures: 4,
                            trust_status: 'probation'
                        }
                    }),
                    update: mockedUpdateFn.mockReturnValue({ eq: chainedEq })
                };
            }
            return {
                insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { outcome_id: 'o-1', timestamp: '2025' } }) }) }),
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: null })
            } as any;
        });

        (supabase.from as any).mockImplementation(fromMock);

        const req = {
            method: 'POST',
            url: 'http://localhost/v1/log-outcome',
            json: async () => ({
                session_id: '123e4567-e89b-12d3-a456-426614174000',
                action_name: 'test_action',
                issue_type: 'bug',
                success: false // Triggers failure increase
            })
        } as unknown as Request;

        const c = {
            req,
            get: (key: string) => {
                if (key === 'agent_id') return 'agent-1';
                if (key === 'customer_id') return 'customer-1';
                if (key === 'parsed_body') return null; // Force raw parse inside function
                if (key === 'validated_action') return { action_id: 'action-1', action_name: 'test_action', action_category: 'test' };
                return null;
            },
            json: (data: any, status: number) => ({ data, status }),
            header: vi.fn()
        } as any;

        const handler = logOutcomeRouter.routes.find((r: any) => r.method === 'POST' && r.path === '/')?.handler as Function;
        await handler(c, vi.fn());

        // We know updateAgentTrust runs async (fire-and-forget), delay slightly
        await new Promise(r => setTimeout(r, 10));

        expect(mockedUpdateFn).toHaveBeenCalled();
        const payload = mockedUpdateFn.mock.calls[0][0];

        // Assert sandbox status at exactly 5th failure
        expect(payload.trust_status).toBe('sandbox');
        expect(payload.consecutive_failures).toBe(5);
        expect(payload.trust_score).toBeLessThan(0.35); // Decreased from 0.35
    });

    it('sandbox policy returns SANDBOX with human_review_required', () => {
        const agentTrust = {
            trust_score: 0.2,
            trust_status: 'sandbox' as const,
            consecutive_failures: 5
        };

        const result = getPolicyDecision({
            rankedActions: [{ action_id: 'a-1', composite_score: 0.8, confidence: 0.9, total_attempts: 10, confidence_tier: 'high', raw_success_rate: 0.8, weighted_success_rate: 0.8, context_similarity: 1.0 }],
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
