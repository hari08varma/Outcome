import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logOutcomeRouter } from '../routes/log-outcome.js';
import { supabase } from '../lib/supabase.js';

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn()
    }
}));

// Mock upstream
vi.mock('../lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
    getCachedScore: vi.fn(() => null),
    getScores: vi.fn().mockResolvedValue({ ranked_actions: [], cold_start: false })
}));
vi.mock('../lib/policy-engine.js', () => ({
    getPolicyDecision: vi.fn(),
    DEFAULT_TRUST: {},
    DEFAULT_POLICY_CONFIG: {}
}));
vi.mock('../middleware/validate-action.js', () => ({
    validateActionMiddleware: async (c: any, next: any) => await next()
}));

describe('Independent Verification Layer in log-outcome', () => {

    let insertMock: any;
    let degradationInsertMock: any;
    let factOutcomesMock: any;

    beforeEach(() => {
        vi.clearAllMocks();

        insertMock = vi.fn().mockResolvedValue({
            data: { outcome_id: 'mock-id', timestamp: new Date().toISOString() },
            error: null
        });
        degradationInsertMock = vi.fn().mockResolvedValue({ error: null });

        const selectMock = vi.fn().mockReturnValue({ single: insertMock });
        factOutcomesMock = { insert: vi.fn().mockReturnValue({ select: selectMock }) };

        const fromMock = vi.fn((table: string) => {
            if (table === 'fact_outcomes') {
                return factOutcomesMock;
            }
            if (table === 'dim_contexts') {
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({ data: { context_id: 'c-1' } })
                };
            }
            if (table === 'degradation_alert_events') {
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    gte: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                    insert: degradationInsertMock
                };
            }
            return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                insert: vi.fn().mockResolvedValue({ error: null })
            };
        });

        (supabase.from as any).mockImplementation(fromMock);
    });

    const createMockReq = (bodyObj: any) => {
        return {
            method: 'POST',
            url: 'http://localhost/v1/log-outcome',
            json: async () => bodyObj
        } as unknown as Request;
    };

    const createContext = (req: Request, bodyObj: any) => {
        return {
            req,
            get: (key: string) => {
                if (key === 'agent_id') return 'agent-1';
                if (key === 'customer_id') return 'customer-1';
                if (key === 'parsed_body') return bodyObj;
                if (key === 'validated_action') return { action_id: 'action-1', action_name: bodyObj.action_name, action_category: 'test' };
                return null;
            },
            json: (data: any, status: number) => ({ data, status }),
            header: vi.fn()
        } as any;
    };

    it('http_status_code 500 overrides agent success=true', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            verifier_signal: { source: 'http_status_code', value: 500 }
        };

        const req = createMockReq(bodyObj);
        const c = createContext(req, bodyObj);

        const handler = logOutcomeRouter.routes.find((r: any) => r.method === 'POST' && r.path === '/')?.handler as Function;
        await handler(c, vi.fn());

        const factOutcomesInsert = (supabase.from('fact_outcomes') as any).insert;
        expect(factOutcomesInsert).toHaveBeenCalled();
        const insertPayload = factOutcomesInsert.mock.calls[0][0];

        expect(insertPayload.success).toBe(false); // verified_success = false
        expect(insertPayload.outcome_score).toBe(0.0); // confidence_override = 0.0
        expect(insertPayload.discrepancy_detected).toBe(true);
    });

    it('human_review false overrides agent success=true', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            verifier_signal: { source: 'human_review', value: false }
        };

        const req = createMockReq(bodyObj);
        const c = createContext(req, bodyObj);

        const handler = logOutcomeRouter.routes.find((r: any) => r.method === 'POST' && r.path === '/')?.handler as Function;
        await handler(c, vi.fn());

        const factOutcomesInsert = (supabase.from('fact_outcomes') as any).insert;
        expect(factOutcomesInsert).toHaveBeenCalled();
        const insertPayload = factOutcomesInsert.mock.calls[0][0];

        expect(insertPayload.success).toBe(false);
        expect(insertPayload.discrepancy_detected).toBe(true);

        // Assert alert was fired
        expect(degradationInsertMock).toHaveBeenCalledWith(expect.objectContaining({
            alert_type: 'success_hallucination',
            severity: 'critical'
        }));
    });

    it('no verifier preserves original agent signal', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            outcome_score: 0.9
        };

        const req = createMockReq(bodyObj);
        const c = createContext(req, bodyObj);

        const handler = logOutcomeRouter.routes.find((r: any) => r.method === 'POST' && r.path === '/')?.handler as Function;
        await handler(c, vi.fn());

        expect(factOutcomesMock.insert).toHaveBeenCalled();
        const insertPayload = factOutcomesMock.insert.mock.calls[0][0];

        expect(insertPayload.success).toBe(true);
        expect(insertPayload.outcome_score).toBe(0.9);
        expect(insertPayload.discrepancy_detected).toBe(false);
    });
});
