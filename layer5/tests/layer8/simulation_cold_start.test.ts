import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const mockFrom = vi.fn();
vi.mock('../../api/lib/supabase.js', () => {
    return {
        supabase: {
            from: (...args: any[]) => mockFrom(...args),
        },
        createClient: () => ({
            from: (...args: any[]) => mockFrom(...args),
        }),
    };
});

function buildChain(overrides: Record<string, any> = {}) {
    const c: any = {};
    for (const m of [
        'select', 'eq', 'gte', 'order', 'limit', 'insert', 'update',
        'maybeSingle', 'single', 'is', 'contains',
    ]) {
        c[m] = vi.fn().mockReturnValue(c);
    }
    Object.assign(c, overrides);
    return c;
}

import { invalidateModelCache } from '../../api/lib/simulation/world-model.js';
import { simulateRouter } from '../../api/routes/simulate.js';
import { runSimulation } from '../../api/lib/simulation/tier-selector.js';

function buildTestApp() {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('agent_id', 'agent-001');
        c.set('customer_id', 'cust-001');
        await next();
    });
    app.route('/v1/simulate', simulateRouter);
    return app;
}

describe('Simulation Cold Start & Fallback', () => {
    beforeEach(() => {
        invalidateModelCache();
        mockFrom.mockReset();
    });

    function setupEmptyMocks(opts: { episodeCount?: number, failAll?: boolean } = {}) {
        if (opts.failAll) {
            mockFrom.mockImplementation(() => {
                throw new Error('Database disconnected');
            });
            return;
        }

        mockFrom.mockImplementation((table: string) => {
            if (table === 'fact_outcomes') {
                return buildChain({ count: opts.episodeCount ?? 0 });
            }
            if (table === 'world_model_artifacts') {
                return buildChain({ data: null, error: { message: 'not found' } });
            }
            if (table === 'dim_agents') {
                return buildChain({ data: { agent_id: 'agent-001' }, error: null });
            }
            if (table === 'dim_actions') {
                return buildChain({
                    data: [{ action_name: 'action1' }, { action_name: 'action2' }, { action_name: 'action3' }],
                    error: null,
                });
            }
            if (table === 'mv_sequence_scores') {
                return buildChain({ data: [], error: null });
            }
            return buildChain({ data: null, error: null });
        });
    }

    const baseRequest = {
        agentId: 'agent-001',
        context: { issue_type: 'test' },
        contextHash: 'ctx-test',
        proposedSequence: ['action1'],
        episodeHistory: [],
        simulateAlternatives: 0,
        maxSequenceDepth: 5,
    };

    it('TEST 1: empty world_model_artifacts -> runSimulation returns tier 1 result', async () => {
        setupEmptyMocks({ episodeCount: 0 });
        const result = await runSimulation(baseRequest);

        expect(result.simulationTier).toBe(1);
        expect(result.primary).toBeDefined();
        expect(result.primary.predictedOutcome).toBeGreaterThanOrEqual(0);
        expect(result.primary.predictedOutcome).toBeLessThanOrEqual(1);
        expect(result.primary.confidenceWidth).toBe(0.8);
        expect(result.simulationWarning).not.toBeNull();
    });

    it('TEST 2: POST /v1/simulate with empty DB -> returns 200 (never 500)', async () => {
        setupEmptyMocks({ episodeCount: 0 });
        const app = buildTestApp();
        const res = await app.request('/v1/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_id: 'agent-001',
                context: { issue_type: 'test' },
                proposed_sequence: ['action1'],
            }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.simulation_tier).toBe(1);
        expect(data.primary).toBeDefined();
        expect(data.tier_explanation).toContain('Historical');
        expect(typeof data.simulation_warning).toBe('string');
        expect(typeof data.primary.predicted_outcome).toBe('number');
    });

    it('TEST 3: simulate with 150 episodes (below Tier 2 threshold) -> uses Tier 1', async () => {
        setupEmptyMocks({ episodeCount: 150 });
        const result = await runSimulation(baseRequest);
        expect(result.simulationTier).toBe(1);
    });

    it('TEST 4: simulate with 300 episodes but no model -> uses Tier 1, not error', async () => {
        setupEmptyMocks({ episodeCount: 300 });
        const result = await runSimulation(baseRequest);
        expect(result.simulationTier).toBe(1);
        expect(result.tierExplanation).toContain('model');
    });

    it('TEST 5: cold start fallback has correct explanation for developers', async () => {
        setupEmptyMocks({ episodeCount: 42 });
        const result = await runSimulation(baseRequest);

        expect(result.tierExplanation).toContain('42');
        expect(result.tierExplanation).toContain('episodes');
        expect(result.tierExplanation.toLowerCase()).not.toContain('error');
        expect(result.tierExplanation.toLowerCase()).not.toContain('failed');
    });

    it('TEST 6: runSimulation never throws — always returns a result', async () => {
        setupEmptyMocks({ failAll: true });

        let errorThrown = false;
        let result = null;
        try {
            result = await runSimulation(baseRequest);
        } catch (err) {
            errorThrown = true;
        }

        expect(errorThrown).toBe(false);
        expect(result).not.toBeNull();
        expect(result!.simulationTier).toBe(1);
        expect(result!.primary).toBeDefined();
    });
});
