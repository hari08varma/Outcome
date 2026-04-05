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
    beforeEach(() => {
        vi.clearAllMocks();
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
});
