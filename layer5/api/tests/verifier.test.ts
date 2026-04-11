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

/**
 * Production-grade mock factory for Supabase query chains.
 * Uses `Object.assign` so the chain object exists before any fn references it.
 */
function makeChain(
    terminalValue: { data: any; error?: any } = { data: null, error: null }
): any {
    const chain: any = Object.assign({}, {
        select: vi.fn(),
        eq: vi.fn(),
        upsert: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        gte: vi.fn(),
        single: vi.fn().mockResolvedValue(terminalValue),
        maybeSingle: vi.fn().mockResolvedValue(terminalValue),
        insert: vi.fn(),
    });
    // All builder methods return the same chain
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.upsert.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    chain.gte.mockReturnValue(chain);
    // insert returns a nested chain (for insert().select().single())
    const insertChain: any = Object.assign({}, {
        select: vi.fn(),
    });
    const singleMock = vi.fn().mockResolvedValue({ data: { outcome_id: 'mock-id', timestamp: new Date().toISOString() }, error: null });
    insertChain.select.mockReturnValue({ single: singleMock });
    chain.insert.mockReturnValue(insertChain);
    return chain;
}

describe('Independent Verification Layer in log-outcome', () => {

    let factOutcomesInsertMock: any;
    let factOutcomesChain: any;
    let degradationInsertMock: any;

    beforeEach(() => {
        vi.clearAllMocks();

        degradationInsertMock = vi.fn().mockResolvedValue({ error: null });

        // fact_outcomes: tracked so tests can inspect the insert payload
        const singleMock = vi.fn().mockResolvedValue({
            data: { outcome_id: 'mock-id', timestamp: new Date().toISOString() },
            error: null,
        });
        factOutcomesInsertMock = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({ single: singleMock }),
        });
        factOutcomesChain = { insert: factOutcomesInsertMock };

        // degradation_alert_events: tracked so tests can check alert was fired
        const degradationChain = makeChain({ data: null, error: null });
        degradationChain.insert = degradationInsertMock;

        (supabase.from as any).mockImplementation((table: string) => {
            switch (table) {
                case 'fact_outcomes': return factOutcomesChain;
                case 'degradation_alert_events': return degradationChain;
                case 'dim_contexts': return makeChain({ data: { context_id: 'ctx-1' }, error: null });
                default: return makeChain({ data: null, error: null });
            }
        });
    });

    const createMockReq = (bodyObj: any) => ({
        method: 'POST',
        url: 'http://localhost/v1/log-outcome',
        json: async () => bodyObj,
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

    it('http_status_code 500 overrides agent success=true', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            verifier_signal: { source: 'http_status_code', value: 500 },
        };

        await runHandler(bodyObj);

        expect(factOutcomesInsertMock).toHaveBeenCalled();
        const insertPayload = factOutcomesInsertMock.mock.calls[0][0];
        expect(insertPayload.success).toBe(false);             // verifier overrides agent
        expect(insertPayload.outcome_score).toBe(0.0);         // confidence_override = 0.0
        expect(insertPayload.discrepancy_detected).toBe(true);
    });

    it('human_review false overrides agent success=true and fires alert', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            verifier_signal: { source: 'human_review', value: false },
        };

        await runHandler(bodyObj);

        expect(factOutcomesInsertMock).toHaveBeenCalled();
        const insertPayload = factOutcomesInsertMock.mock.calls[0][0];
        expect(insertPayload.success).toBe(false);
        expect(insertPayload.discrepancy_detected).toBe(true);

        // degradation alert must be fired
        expect(degradationInsertMock).toHaveBeenCalledWith(expect.objectContaining({
            alert_type: 'success_hallucination',
            severity: 'critical',
        }));
    });

    it('no verifier preserves original agent signal', async () => {
        const bodyObj = {
            session_id: '123e4567-e89b-12d3-a456-426614174000',
            action_name: 'test_action',
            issue_type: 'bug',
            success: true,
            outcome_score: 0.9,
        };

        await runHandler(bodyObj);

        expect(factOutcomesInsertMock).toHaveBeenCalled();
        const insertPayload = factOutcomesInsertMock.mock.calls[0][0];
        expect(insertPayload.success).toBe(true);
        expect(insertPayload.outcome_score).toBe(0.9);
        expect(insertPayload.discrepancy_detected).toBe(false);
    });
});
