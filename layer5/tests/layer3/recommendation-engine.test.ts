import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/lib/supabase.js', () => {
    return {
        supabase: {
            from: vi.fn(),
        },
    };
});

import { supabase } from '../../api/lib/supabase.js';
import { getRecommendation } from '../../api/lib/recommendation/engine.js';

type QueryResult = {
    data?: unknown;
    error?: unknown;
    count?: number | null;
};

function makeAwaitableQuery(result: QueryResult): any {
    const query: any = {};

    for (const method of ['select', 'eq', 'neq', 'gte', 'in', 'order', 'limit']) {
        query[method] = vi.fn().mockReturnValue(query);
    }

    query.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);

    return query;
}

describe('Recommendation Engine - silent failure propagation', () => {
    const prevEnv: Record<string, string | undefined> = {
        LI_FEATURE_NOISE_AWARE_EVIDENCE_GATE_V1: process.env.LI_FEATURE_NOISE_AWARE_EVIDENCE_GATE_V1,
        LI_NOISY_WARMUP_MIN_SAMPLES: process.env.LI_NOISY_WARMUP_MIN_SAMPLES,
        LI_FEATURE_SIMULATION_SHADOW_V1: process.env.LI_FEATURE_SIMULATION_SHADOW_V1,
        LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES: process.env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES,
        LI_FEATURE_SIMULATION_CONFIDENCE_CEILING_V1: process.env.LI_FEATURE_SIMULATION_CONFIDENCE_CEILING_V1,
        LI_SIMULATION_CONFIDENCE_CEILING: process.env.LI_SIMULATION_CONFIDENCE_CEILING,
        LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1: process.env.LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1,
        LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES: process.env.LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        for (const [key, value] of Object.entries(prevEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it('sets _silent_failure_warning=true for early_signal and queries alerts by action_id', async () => {
        const inCalls: Array<[string, unknown]> = [];

        const dimActionsQuery = makeAwaitableQuery({
            data: [
                { action_name: 'action_alpha' },
                { action_name: 'action_beta' },
            ],
            error: null,
        });

        const taskActionsQuery = makeAwaitableQuery({
            data: [
                {
                    action_id: 'a-1',
                    action_name: 'action_alpha',
                    total_count: 12,
                    success_count: 9,
                    success_rate: 0.75,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
                {
                    action_id: 'a-2',
                    action_name: 'action_beta',
                    total_count: 14,
                    success_count: 7,
                    success_rate: 0.5,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
            ],
            error: null,
        });

        const alertsQuery = makeAwaitableQuery({ count: 1, error: null });
        alertsQuery.in = vi.fn((column: string, value: unknown) => {
            inCalls.push([column, value]);
            return alertsQuery;
        });

        const resolutionQuery = makeAwaitableQuery({ data: [], error: null });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'dim_actions') return dimActionsQuery;
            if (table === 'mv_task_action_performance') return taskActionsQuery;
            if (table === 'fact_outcomes') return resolutionQuery;
            if (table === 'degradation_alert_events') return alertsQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const result = await getRecommendation('cust-1', 'task_one');

        expect(result.state).toBe('early_signal');
        expect(result._silent_failure_warning).toBe(true);

        const actionIdInCall = inCalls.find(([column]) => column === 'action_id');
        expect(actionIdInCall).toBeTruthy();
        expect(actionIdInCall?.[1]).toEqual(['a-1', 'a-2']);
    });

    it('keeps _silent_failure_warning=true in close-result early_signal branch (absolute delta < 0.08)', async () => {
        const dimActionsQuery = makeAwaitableQuery({
            data: [
                { action_name: 'action_alpha' },
                { action_name: 'action_beta' },
            ],
            error: null,
        });

        const taskActionsQuery = makeAwaitableQuery({
            data: [
                {
                    action_id: 'b-1',
                    action_name: 'action_alpha',
                    total_count: 32,
                    success_count: 24,
                    success_rate: 0.75,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
                {
                    action_id: 'b-2',
                    action_name: 'action_beta',
                    total_count: 30,
                    success_count: 21,
                    success_rate: 0.70,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
            ],
            error: null,
        });

        const alertsQuery = makeAwaitableQuery({ count: 1, error: null });
        const resolutionQuery = makeAwaitableQuery({ data: [], error: null });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'dim_actions') return dimActionsQuery;
            if (table === 'mv_task_action_performance') return taskActionsQuery;
            if (table === 'fact_outcomes') return resolutionQuery;
            if (table === 'degradation_alert_events') return alertsQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const result = await getRecommendation('cust-2', 'task_two');

        expect(result.state).toBe('early_signal');
        expect(result.improvement).toBeNull();
        expect(result._silent_failure_warning).toBe(true);
    });

    it('noise-aware gate increases warmup threshold for noisy tasks', async () => {
        process.env.LI_FEATURE_NOISE_AWARE_EVIDENCE_GATE_V1 = 'true';
        process.env.LI_NOISY_WARMUP_MIN_SAMPLES = '30';

        const dimActionsQuery = makeAwaitableQuery({
            data: [
                { action_name: 'action_alpha' },
                { action_name: 'action_beta' },
            ],
            error: null,
        });

        const taskActionsQuery = makeAwaitableQuery({
            data: [
                {
                    action_id: 'n-1',
                    action_name: 'action_alpha',
                    total_count: 20,
                    success_count: 9,
                    success_rate: 0.45,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
                {
                    action_id: 'n-2',
                    action_name: 'action_beta',
                    total_count: 20,
                    success_count: 8,
                    success_rate: 0.40,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
            ],
            error: null,
        });

        const resolutionQuery = makeAwaitableQuery({ data: [], error: null });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'dim_actions') return dimActionsQuery;
            if (table === 'mv_task_action_performance') return taskActionsQuery;
            if (table === 'fact_outcomes') return resolutionQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const result = await getRecommendation('cust-noise', 'payment_task');

        expect(result.state).toBe('no_data');
        expect(result._noise_gate?.is_noisy_task).toBe(true);
        expect(result._noise_gate?.required_samples).toBe(30);
        expect(result._noise_gate?.decision_gate_reason).toContain('noise_score_above_threshold');
    });

    it('simulation guardrails cap confidence and block stable replacement until exploit gate sample target', async () => {
        process.env.LI_FEATURE_SIMULATION_SHADOW_V1 = 'true';
        process.env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES = '80';
        process.env.LI_FEATURE_SIMULATION_CONFIDENCE_CEILING_V1 = 'true';
        process.env.LI_SIMULATION_CONFIDENCE_CEILING = '0.65';
        process.env.LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1 = 'true';
        process.env.LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES = '60';

        const dimActionsQuery = makeAwaitableQuery({
            data: [
                { action_name: 'action_alpha' },
                { action_name: 'action_beta' },
            ],
            error: null,
        });

        const taskActionsQuery = makeAwaitableQuery({
            data: [
                {
                    action_id: 's-1',
                    action_name: 'action_alpha',
                    total_count: 55,
                    success_count: 45,
                    success_rate: 0.82,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
                {
                    action_id: 's-2',
                    action_name: 'action_beta',
                    total_count: 55,
                    success_count: 30,
                    success_rate: 0.55,
                    ml_score: null,
                    last_seen_at: new Date().toISOString(),
                },
            ],
            error: null,
        });

        const resolutionQuery = makeAwaitableQuery({ data: [], error: null });
        const alertsQuery = makeAwaitableQuery({ count: 0, error: null });
        const decisionsQuery = makeAwaitableQuery({
            data: [{ id: 'd-1' }, { id: 'd-2' }],
            error: null,
        });
        const counterfactualsQuery = makeAwaitableQuery({
            data: [{
                unchosen_action_id: 's-1',
                counterfactual_est: 0.95,
                ips_weight: 0.25,
                created_at: new Date().toISOString(),
            }],
            error: null,
        });

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'dim_actions') return dimActionsQuery;
            if (table === 'mv_task_action_performance') return taskActionsQuery;
            if (table === 'fact_outcomes') return resolutionQuery;
            if (table === 'degradation_alert_events') return alertsQuery;
            if (table === 'fact_decisions') return decisionsQuery;
            if (table === 'fact_outcome_counterfactuals') return counterfactualsQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const result = await getRecommendation('cust-sim', 'rollback_task');

        expect(result.state).toBe('early_signal');
        expect(result.confidence).toBeLessThanOrEqual(0.65);
        expect(result._simulation_guardrail?.shadow_applied).toBe(true);
        expect(result._simulation_guardrail?.confidence_ceiling_applied).toBe(true);
        expect(result._simulation_guardrail?.exploit_gate_applied).toBe(true);
    });
});
