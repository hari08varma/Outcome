import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logOutcomeRouter } from '../routes/log-outcome.js';
import { supabase } from '../lib/supabase.js';

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn()
    }
}));

// Mock out the downstream scoring dependencies since we are only testing the top half
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

describe('Sanitization in log-outcome', () => {
    let insertMock: any;

    beforeEach(() => {
        vi.clearAllMocks();

        insertMock = vi.fn().mockResolvedValue({
            data: { outcome_id: 'mock-id', timestamp: new Date().toISOString() },
            error: null
        });

        const selectMock = vi.fn().mockReturnValue({ single: insertMock });
        const fromMock = vi.fn((table: string) => {
            if (table === 'fact_outcomes') {
                return { insert: vi.fn().mockReturnValue({ select: selectMock }) };
            }
            if (table === 'dim_contexts') {
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({ data: { context_id: 'c-1' } })
                };
            }
            if (table === 'agent_trust_scores' || table === 'degradation_alert_events') {
                // Return dummy so fire-and-forget checks don't crash
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                    insert: vi.fn().mockResolvedValue({ error: null })
                };
            }
            return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: null })
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

    it('raw_context deep object is sanitized before insert', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            raw_context: { a: { b: { c: { d: { e: { f: 'deep' } } } } } }
        };

        const req = createMockReq(bodyObj);
        const c = createContext(req, bodyObj);

        // Directly call the handler for POST /
        const handler = logOutcomeRouter.routes.find((r: any) => r.method === 'POST' && r.path === '/')?.handler as Function;
        await handler(c, vi.fn());

        // Find the insert call to fact_outcomes
        const factOutcomesInsert = (supabase.from('fact_outcomes') as any).insert;
        expect(factOutcomesInsert).toHaveBeenCalled();
        const insertPayload = factOutcomesInsert.mock.calls[0][0];

        // Depth 6 (f='deep') is past maxDepth=5, so 'e' should be truncated
        expect(insertPayload.raw_context.a.b.c.d.e).toBe('[truncated: max depth exceeded]');
    });

    it('null bytes in error_message are stripped before insert', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: false,
            error_message: 'Payment\0 failed'
        };

        const req = createMockReq(bodyObj);
        const c = createContext(req, bodyObj);

        const handler = logOutcomeRouter.routes.find((r: any) => r.method === 'POST' && r.path === '/')?.handler as Function;
        await handler(c, vi.fn());

        const factOutcomesInsert = (supabase.from('fact_outcomes') as any).insert;
        expect(factOutcomesInsert).toHaveBeenCalled();
        const insertPayload = factOutcomesInsert.mock.calls[0][0];

        // Null byte \0 should be stripped
        expect(insertPayload.error_message).toBe('Payment failed');
    });

    it('prototype pollution key in raw_context is blocked', async () => {
        // We use JSON.parse to mimic a real payload that somehow parsed __proto__ 
        // Note: Zod record might leave it if parsed blindly, so sanitize handles it
        const rawJsonStr = '{"session_id":"123e4567-e89b-12d3-a456-426614174000","action_name":"test","issue_type":"bug","success":true,"raw_context":{"__proto__":{"admin":true},"user":"test"}}';
        const bodyObj = JSON.parse(rawJsonStr);

        const req = createMockReq(bodyObj);
        const c = createContext(req, bodyObj);

        const handler = logOutcomeRouter.routes.find((r: any) => r.method === 'POST' && r.path === '/')?.handler as Function;
        await handler(c, vi.fn());

        const factOutcomesInsert = (supabase.from('fact_outcomes') as any).insert;
        expect(factOutcomesInsert).toHaveBeenCalled();
        const insertPayload = factOutcomesInsert.mock.calls[0][0];

        expect(insertPayload.raw_context.user).toBe('test');
        expect(insertPayload.raw_context).not.toHaveProperty('__proto__');

        // Assert pollution didn't occur
        expect((Object.prototype as any).admin).toBeUndefined();
    });
});
