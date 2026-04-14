import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
    },
}));

import { supabase } from '../../api/lib/supabase.js';
import {
    fetchAvailableTasks,
    fetchTaskActionPerformance,
    ZERO_UUID_AGENT_ID,
} from '../../api/lib/recommendation/task-performance.js';

type QueryResult = {
    data: unknown;
    error: { message: string; code?: string | null } | null;
};

function makeQuery(result: QueryResult) {
    const q: any = {};
    for (const method of ['select', 'eq', 'neq', 'gte', 'in', 'not', 'order']) {
        q[method] = vi.fn().mockReturnValue(q);
    }
    q.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
    return q;
}

describe('task performance fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses mv_task_action_performance_180d when available', async () => {
        const mvRows = [
            {
                action_id: 'a1',
                action_name: 'restart_service',
                total_count: 5,
                success_count: 4,
                success_rate: 0.8,
                ml_score: 0.77,
                last_seen_at: '2026-04-03T10:00:00.000Z',
            },
        ];

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({ data: mvRows, error: null }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({ data: [], error: null }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchTaskActionPerformance({
            customerId: 'cust-1',
            taskName: 'incident_resolution',
            agentId: null,
            windowStart: '2026-01-01T00:00:00.000Z',
        });

        expect(result.source).toBe('mv');
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
            action_id: 'a1',
            action_name: 'restart_service',
            total_count: 5,
            success_count: 4,
            success_rate: 0.8,
            ml_score: 0.77,
        });
        expect(vi.mocked(supabase.from).mock.calls.map((c) => c[0])).toEqual([
            'mv_task_action_performance_180d',
            'fact_outcomes',
        ]);
    });

    it('falls back to fact_outcomes aggregation when mv is missing', async () => {
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({
                    data: null,
                    error: {
                        code: '42P01',
                        message: 'relation "mv_task_action_performance_180d" does not exist',
                    },
                }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({
                    data: [
                        {
                            action_id: 'a1',
                            success: true,
                            timestamp: '2026-04-01T10:00:00.000Z',
                            dim_actions: { action_name: 'restart_service' },
                        },
                        {
                            action_id: 'a1',
                            success: false,
                            timestamp: '2026-04-02T10:00:00.000Z',
                            dim_actions: { action_name: 'restart_service' },
                        },
                        {
                            action_id: 'a2',
                            success: true,
                            timestamp: '2026-04-02T12:00:00.000Z',
                            dim_actions: [{ action_name: 'rollback_deploy' }],
                        },
                    ],
                    error: null,
                }) as any;
            }

            if (table === 'mv_action_scores') {
                return makeQuery({
                    data: [
                        {
                            action_id: 'a1',
                            weighted_success_rate: 0.70,
                            view_refreshed_at: '2026-04-01T12:00:00.000Z',
                        },
                        {
                            action_id: 'a1',
                            weighted_success_rate: 0.75,
                            view_refreshed_at: '2026-04-02T12:00:00.000Z',
                        },
                        {
                            action_id: 'a2',
                            weighted_success_rate: 0.90,
                            view_refreshed_at: '2026-04-02T12:00:00.000Z',
                        },
                    ],
                    error: null,
                }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchTaskActionPerformance({
            customerId: 'cust-1',
            taskName: 'incident_resolution',
            agentId: null,
        });

        expect(result.source).toBe('fact_fallback');
        expect(result.rows).toHaveLength(2);

        const byAction = new Map(result.rows.map((row) => [row.action_id, row]));
        expect(byAction.get('a1')).toMatchObject({
            action_name: 'restart_service',
            total_count: 2,
            success_count: 1,
            success_rate: 0.5,
            ml_score: 0.75,
        });
        expect(byAction.get('a2')).toMatchObject({
            action_name: 'rollback_deploy',
            total_count: 1,
            success_count: 1,
            success_rate: 1,
            ml_score: 0.9,
        });

        expect(vi.mocked(supabase.from).mock.calls.map((c) => c[0])).toEqual([
            'mv_task_action_performance_180d',
            'fact_outcomes',
            'mv_action_scores',
        ]);
    });

    it('uses execution_status polarity before legacy success in fact fallback scoring', async () => {
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({
                    data: null,
                    error: {
                        code: '42P01',
                        message: 'relation "mv_task_action_performance_180d" does not exist',
                    },
                }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({
                    data: [
                        {
                            action_id: 'a-status',
                            success: true,
                            execution_status: 'FAILED',
                            timestamp: '2026-04-02T10:00:00.000Z',
                            dim_actions: { action_name: 'restart_service' },
                        },
                        {
                            action_id: 'a-status',
                            success: true,
                            execution_status: 'FAILED',
                            timestamp: '2026-04-03T10:00:00.000Z',
                            dim_actions: { action_name: 'restart_service' },
                        },
                    ],
                    error: null,
                }) as any;
            }

            if (table === 'mv_action_scores') {
                return makeQuery({ data: [], error: null }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchTaskActionPerformance({
            customerId: 'cust-1',
            taskName: 'incident_resolution',
            agentId: null,
        });

        expect(result.source).toBe('fact_fallback');
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.success_rate).toBe(1);
        expect(result.rows[0]?.resolution_rate).toBeCloseTo(0, 6);
    });

    it('falls back to fact_outcomes task list and normalizes task names', async () => {
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({
                    data: null,
                    error: {
                        code: '42P01',
                        message: 'relation "mv_task_action_performance_180d" does not exist',
                    },
                }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({
                    data: [
                        { task_name: 'incident_resolution' },
                        { task_name: ' incident_resolution ' },
                        { task_name: 'payment_failed' },
                        { task_name: '   ' },
                    ],
                    error: null,
                }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchAvailableTasks('cust-1', null);

        expect(result.source).toBe('fact_fallback');
        expect(result.tasks).toEqual(['incident_resolution', 'payment_failed']);
    });

    it('keeps mv task source when mv is healthy', async () => {
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            expect(table).toBe('mv_task_action_performance_180d');
            return makeQuery({
                data: [
                    { task_name: 'billing_issue' },
                    { task_name: 'incident_resolution' },
                    { task_name: 'incident_resolution' },
                ],
                error: null,
            }) as any;
        });

        const result = await fetchAvailableTasks('cust-1', ZERO_UUID_AGENT_ID);

        expect(result.source).toBe('mv');
        expect(result.tasks).toEqual(['billing_issue', 'incident_resolution']);
        expect(vi.mocked(supabase.from).mock.calls.map((c) => c[0])).toEqual([
            'mv_task_action_performance_180d',
        ]);
    });

    it('excludes low-quality outcomes older than 30 days when aggregating fallback resolution rates', async () => {
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({
                    data: null,
                    error: {
                        code: '42P01',
                        message: 'relation "mv_task_action_performance_180d" does not exist',
                    },
                }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({
                    data: [
                        {
                            action_id: 'a3',
                            success: false,
                            outcome_score: 0.1,
                            timestamp: '2026-02-01T10:00:00.000Z',
                            dim_actions: { action_name: 'restart_worker' },
                        },
                        {
                            action_id: 'a3',
                            success: true,
                            outcome_score: 0.9,
                            timestamp: '2026-04-02T10:00:00.000Z',
                            dim_actions: { action_name: 'restart_worker' },
                        },
                    ],
                    error: null,
                }) as any;
            }

            if (table === 'mv_action_scores') {
                return makeQuery({ data: [], error: null }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchTaskActionPerformance({
            customerId: 'cust-1',
            taskName: 'incident_resolution',
            agentId: null,
        });

        expect(result.source).toBe('fact_fallback');
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.resolution_rate).toBeCloseTo(0.9, 4);
        expect(result.rows[0]?.success_rate).toBe(0.5);
    });

    it('applies a drift penalty to historical import signal when live trend declines', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-15T00:00:00.000Z'));

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({
                    data: null,
                    error: {
                        code: '42P01',
                        message: 'relation "mv_task_action_performance_180d" does not exist',
                    },
                }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({
                    data: [
                        {
                            action_id: 'a-declining',
                            success: true,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-01T00:00:00.000Z',
                            dim_actions: { action_name: 'declining_action' },
                        },
                        {
                            action_id: 'a-declining',
                            success: true,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-02T00:00:00.000Z',
                            dim_actions: { action_name: 'declining_action' },
                        },
                        {
                            action_id: 'a-declining',
                            success: true,
                            outcome_score: 0.9,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-12T00:00:00.000Z',
                            dim_actions: { action_name: 'declining_action' },
                        },
                        {
                            action_id: 'a-declining',
                            success: true,
                            outcome_score: 0.5,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-12T00:00:00.000Z',
                            dim_actions: { action_name: 'declining_action' },
                        },
                        {
                            action_id: 'a-declining',
                            success: false,
                            outcome_score: 0.1,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-12T00:00:00.000Z',
                            dim_actions: { action_name: 'declining_action' },
                        },
                        {
                            action_id: 'a-stable',
                            success: true,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-01T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_action' },
                        },
                        {
                            action_id: 'a-stable',
                            success: true,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-02T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_action' },
                        },
                        {
                            action_id: 'a-stable',
                            success: false,
                            outcome_score: 0.1,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-12T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_action' },
                        },
                        {
                            action_id: 'a-stable',
                            success: true,
                            outcome_score: 0.5,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-12T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_action' },
                        },
                        {
                            action_id: 'a-stable',
                            success: true,
                            outcome_score: 0.9,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-12T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_action' },
                        },
                    ],
                    error: null,
                }) as any;
            }

            if (table === 'mv_action_scores') {
                return makeQuery({ data: [], error: null }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchTaskActionPerformance({
            customerId: 'cust-1',
            taskName: 'incident_resolution',
            agentId: null,
        });

        const byAction = new Map(result.rows.map((row) => [row.action_id, row]));
        const declining = byAction.get('a-declining');
        const stable = byAction.get('a-stable');

        expect(declining).toBeTruthy();
        expect(stable).toBeTruthy();
        expect(stable!.resolution_rate).toBeGreaterThan(declining!.resolution_rate);
        expect(stable!.effective_sample_count).toBeGreaterThan(declining!.effective_sample_count);
    });

    it('raises import floor for stable actions and reduces it for volatile actions', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-15T00:00:00.000Z'));

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({
                    data: null,
                    error: {
                        code: '42P01',
                        message: 'relation "mv_task_action_performance_180d" does not exist',
                    },
                }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({
                    data: [
                        {
                            action_id: 'a-stable-floor',
                            success: true,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-01T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_floor' },
                        },
                        {
                            action_id: 'a-stable-floor',
                            success: true,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-02T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_floor' },
                        },
                        {
                            action_id: 'a-stable-floor',
                            success: true,
                            outcome_score: 0.2,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-14T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_floor' },
                        },
                        {
                            action_id: 'a-stable-floor',
                            success: true,
                            outcome_score: 0.2,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-14T00:00:00.000Z',
                            dim_actions: { action_name: 'stable_floor' },
                        },
                        {
                            action_id: 'a-volatile-floor',
                            success: true,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-01T00:00:00.000Z',
                            dim_actions: { action_name: 'volatile_floor' },
                        },
                        {
                            action_id: 'a-volatile-floor',
                            success: false,
                            outcome_score: 1,
                            ingestion_source: 'import',
                            timestamp: '2025-12-02T00:00:00.000Z',
                            dim_actions: { action_name: 'volatile_floor' },
                        },
                        {
                            action_id: 'a-volatile-floor',
                            success: true,
                            outcome_score: 0.2,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-14T00:00:00.000Z',
                            dim_actions: { action_name: 'volatile_floor' },
                        },
                        {
                            action_id: 'a-volatile-floor',
                            success: false,
                            outcome_score: 0.2,
                            ingestion_source: 'sdk',
                            timestamp: '2026-04-14T00:00:00.000Z',
                            dim_actions: { action_name: 'volatile_floor' },
                        },
                    ],
                    error: null,
                }) as any;
            }

            if (table === 'mv_action_scores') {
                return makeQuery({ data: [], error: null }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchTaskActionPerformance({
            customerId: 'cust-1',
            taskName: 'incident_resolution',
            agentId: null,
        });

        const byAction = new Map(result.rows.map((row) => [row.action_id, row]));
        const stableFloor = byAction.get('a-stable-floor');
        const volatileFloor = byAction.get('a-volatile-floor');

        expect(stableFloor).toBeTruthy();
        expect(volatileFloor).toBeTruthy();
        expect(stableFloor!.resolution_rate).toBeGreaterThan(volatileFloor!.resolution_rate);
        expect(stableFloor!.effective_sample_count).toBeGreaterThan(volatileFloor!.effective_sample_count);
    });

    it('applies sample-size confidence to effective sample weighting', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-15T00:00:00.000Z'));

        const rows: Array<Record<string, unknown>> = [];
        for (let i = 0; i < 3; i += 1) {
            rows.push({
                action_id: 'a-small-sample',
                success: true,
                outcome_score: 0.8,
                ingestion_source: 'sdk',
                timestamp: '2026-04-14T00:00:00.000Z',
                dim_actions: { action_name: 'small_sample' },
            });
        }
        for (let i = 0; i < 40; i += 1) {
            rows.push({
                action_id: 'a-large-sample',
                success: true,
                outcome_score: 0.8,
                ingestion_source: 'sdk',
                timestamp: '2026-04-14T00:00:00.000Z',
                dim_actions: { action_name: 'large_sample' },
            });
        }

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'mv_task_action_performance_180d') {
                return makeQuery({
                    data: null,
                    error: {
                        code: '42P01',
                        message: 'relation "mv_task_action_performance_180d" does not exist',
                    },
                }) as any;
            }

            if (table === 'fact_outcomes') {
                return makeQuery({ data: rows, error: null }) as any;
            }

            if (table === 'mv_action_scores') {
                return makeQuery({ data: [], error: null }) as any;
            }

            throw new Error(`unexpected table: ${table}`);
        });

        const result = await fetchTaskActionPerformance({
            customerId: 'cust-1',
            taskName: 'incident_resolution',
            agentId: null,
        });

        const byAction = new Map(result.rows.map((row) => [row.action_id, row]));
        const smallSample = byAction.get('a-small-sample');
        const largeSample = byAction.get('a-large-sample');

        expect(smallSample).toBeTruthy();
        expect(largeSample).toBeTruthy();
        expect(smallSample!.resolution_rate).toBeCloseTo(0.8, 4);
        expect(largeSample!.resolution_rate).toBeCloseTo(0.8, 4);

        const smallPerOutcomeWeight = smallSample!.effective_sample_count / smallSample!.total_count;
        const largePerOutcomeWeight = largeSample!.effective_sample_count / largeSample!.total_count;
        expect(largePerOutcomeWeight).toBeGreaterThan(smallPerOutcomeWeight);
    });
});
