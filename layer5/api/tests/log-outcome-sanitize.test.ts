import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logOutcomeRouter } from '../routes/log-outcome.js';
import { supabase } from '../lib/supabase.js';

vi.mock('../lib/supabase.js', () => ({
    supabase: { from: vi.fn() }
}));

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
    validateActionMiddleware: async (c: any, next: any) => await next(),
    normalizeActionName: (x: string) => x,
    recordActionAlias: vi.fn()
}));

vi.mock('../lib/outcome-score-inference.js', () => ({
    fetchActionBaseline: vi.fn().mockResolvedValue(null),
    inferOutcomeScore: vi.fn().mockReturnValue({ score: 0.5, confidence: 0.6, class: 'neutral' }),
    invalidateActionBaselineCache: vi.fn(),
}));

vi.mock('../lib/outcome-orchestrator.js', () => ({
    orchestrateOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/outcome-ingest-queue.js', () => ({
    OUTCOME_INGEST_WORKER_BYPASS_HEADER: 'x-li-outcome-worker',
    enqueueDurable: vi.fn().mockResolvedValue('ingress-id-1'),
    getOutcomeQueueMode: vi.fn().mockReturnValue('sync'),
}));

/**
 * Creates a fluent Supabase chain mock that supports any combination of:
 * select / eq / upsert / insert / order / limit / maybeSingle / single
 *
 * @param terminalValue — the value resolved by maybeSingle() / single()
 * @param insertValue   — the value resolved by insert().select().single()
 */
function makeChain(
    terminalValue: { data: any; error?: any } = { data: null, error: null },
    insertValue: { data: any; error?: any } = { data: { outcome_id: 'mock-id', timestamp: new Date().toISOString() }, error: null }
) {
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.upsert = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.gte = vi.fn().mockReturnValue(chain);
    chain.maybeSingle = vi.fn().mockResolvedValue(terminalValue);
    chain.single = vi.fn().mockResolvedValue(terminalValue);
    // insert returns a nested chain where select().single() resolves the record
    const insertChain: any = {};
    insertChain.select = vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue(insertValue) });
    chain.insert = vi.fn().mockReturnValue(insertChain);
    return chain;
}

describe('Sanitization in log-outcome', () => {
    let factOutcomesChain: any;

    beforeEach(() => {
        vi.clearAllMocks();

        const outcomeRow = { outcome_id: 'mock-id', timestamp: new Date().toISOString() };

        // fact_outcomes needs a specialised insert chain tracked by the tests
        factOutcomesChain = {
            insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: outcomeRow, error: null })
                })
            })
        };

        (supabase.from as any).mockImplementation((table: string) => {
            switch (table) {
                case 'fact_outcomes':
                    return factOutcomesChain;

                case 'dim_contexts':
                    // Supports upsert().select().maybeSingle() AND select().eq().maybeSingle()
                    return makeChain({ data: { context_id: 'ctx-1' }, error: null });

                case 'fact_outcome_idempotency':
                    // handleIdempotency: select().eq().maybeSingle() → no existing key
                    // saveIdempotencyRecord: insert().select().single()
                    return makeChain({ data: null, error: null });

                case 'fact_decisions':
                    // resolveDecisionId: select().eq().maybeSingle()
                    return makeChain({ data: null, error: null });

                case 'dim_actions':
                    // resolveActionId: select().eq().maybeSingle()
                    return makeChain({ data: null, error: null });

                case 'dim_agents':
                    return makeChain({ data: null, error: null });

                case 'dim_customers':
                    return makeChain({ data: null, error: null });

                // trust/degradation are fire-and-forget — just resolve cleanly
                case 'agent_trust_scores':
                case 'degradation_alert_events':
                default:
                    return makeChain({ data: null, error: null });
            }
        });
    });

    const createMockReq = (bodyObj: any) => ({
        method: 'POST',
        url: 'http://localhost/v1/log-outcome',
        json: async () => bodyObj,
        header: (name: string) => undefined,
    } as unknown as Request);

    const createContext = (req: Request, bodyObj: any) => ({
        req,
        get: (key: string) => {
            if (key === 'agent_id') return 'agent-1';
            if (key === 'customer_id') return 'customer-1';
            if (key === 'parsed_body') return bodyObj;
            if (key === 'validated_action') return { action_id: 'action-1', action_name: bodyObj.action_name, action_category: 'test' };
            return null;
        },
        json: (data: any, status: number) => ({ data, status }),
        header: vi.fn(),
    } as any);

    // ── Helper: run handler and assert it did NOT 500 ──────────────────────────
    async function runHandler(bodyObj: any) {
        const req = createMockReq(bodyObj);
        const c = createContext(req, bodyObj);
        const handler = logOutcomeRouter.routes.find(
            (r: any) => r.method === 'POST' && r.path === '/'
        )?.handler as Function;
        const res = await handler(c, vi.fn());
        if (res?.status === 500) {
            throw new Error(`Handler crashed with 500: ${JSON.stringify(res.data)}`);
        }
        return res;
    }

    // ── Tests ──────────────────────────────────────────────────────────────────

    it('raw_context deep object is sanitized before insert', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            raw_context: { a: { b: { c: { d: { e: { f: 'deep' } } } } } },
        };

        await runHandler(bodyObj);

        expect(factOutcomesChain.insert).toHaveBeenCalled();
        const insertPayload = factOutcomesChain.insert.mock.calls[0][0];

        // Depth 6 (key 'f') is past maxDepth=5, so 'e' should be replaced
        expect(insertPayload.raw_context.a.b.c.d.e).toBe('[truncated: max depth exceeded]');
    });

    it('null bytes in error_message are stripped before insert', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: false,
            error_message: 'Payment\0 failed',
        };

        await runHandler(bodyObj);

        expect(factOutcomesChain.insert).toHaveBeenCalled();
        const insertPayload = factOutcomesChain.insert.mock.calls[0][0];
        expect(insertPayload.error_message).toBe('Payment failed');
    });

    it('prototype pollution key in raw_context is blocked', async () => {
        const rawJsonStr = '{"session_id":"123e4567-e89b-12d3-a456-426614174000","action_name":"test","issue_type":"bug","success":true,"raw_context":{"__proto__":{"admin":true},"user":"test"}}';
        const bodyObj = JSON.parse(rawJsonStr);

        await runHandler(bodyObj);

        expect(factOutcomesChain.insert).toHaveBeenCalled();
        const insertPayload = factOutcomesChain.insert.mock.calls[0][0];

        expect(insertPayload.raw_context.user).toBe('test');
        expect(Object.keys(insertPayload.raw_context)).not.toContain('__proto__');
        expect((Object.prototype as any).admin).toBeUndefined();
    });
});
