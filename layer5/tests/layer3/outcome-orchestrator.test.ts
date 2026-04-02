import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
        rpc: vi.fn(),
    },
}));

vi.mock('../../api/lib/ips-engine.js', () => ({
    writeCounterfactuals: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/lib/sequence-tracker.js', () => ({
    upsertSequence: vi.fn().mockResolvedValue(undefined),
    closeSequence: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/lib/reward-backprop.js', () => ({
    backpropagateReward: vi.fn().mockResolvedValue(undefined),
}));

import { supabase } from '../../api/lib/supabase.js';
import { orchestrateOutcome } from '../../api/lib/outcome-orchestrator.js';

type TrustRow = {
    trust_id: string;
    trust_score: number;
    total_decisions: number;
    correct_decisions: number;
    consecutive_failures: number;
    trust_status: string;
};

type MockState = {
    factOutcomesByAgent: Record<string, Array<{ success: boolean }>>;
    trustRowsByAgent: Record<string, TrustRow>;
    contextsByCustomerIssue: Record<string, string>;
    contextOutcomeCounts: Record<string, number>;
    alerts: Array<Record<string, any>>;
    trustUpserts: Array<Record<string, any>>;
    trustUpdates: Array<{ payload: Record<string, any>; filters: Array<{ column: string; value: any }> }>;
    rpcCalls: Array<{ fn: string; args: Record<string, any> }>;
};

function makeBaseState(): MockState {
    return {
        factOutcomesByAgent: {},
        trustRowsByAgent: {},
        contextsByCustomerIssue: {},
        contextOutcomeCounts: {},
        alerts: [],
        trustUpserts: [],
        trustUpdates: [],
        rpcCalls: [],
    };
}

function createSupabaseQuery(table: string, state: MockState): any {
    const filters: Array<{ op: string; column: string; value: any }> = [];
    let selected = '';
    let selectOptions: Record<string, any> | undefined;
    let limitedTo: number | null = null;
    let pendingUpdate: Record<string, any> | null = null;

    const query: any = {
        select: vi.fn((columns: string, options?: Record<string, any>) => {
            selected = columns;
            selectOptions = options;
            return query;
        }),
        eq: vi.fn((column: string, value: any) => {
            filters.push({ op: 'eq', column, value });
            return query;
        }),
        gte: vi.fn((column: string, value: any) => {
            filters.push({ op: 'gte', column, value });
            return query;
        }),
        ilike: vi.fn((column: string, value: any) => {
            filters.push({ op: 'ilike', column, value });
            return query;
        }),
        order: vi.fn(() => query),
        limit: vi.fn((value: number) => {
            limitedTo = value;
            return query;
        }),
        maybeSingle: vi.fn(async () => {
            const result = execute();
            const first = result.data?.[0] ?? null;
            return { data: first, error: result.error ?? null, count: result.count ?? null };
        }),
        update: vi.fn((payload: Record<string, any>) => {
            pendingUpdate = payload;
            return query;
        }),
        upsert: vi.fn(async (payload: Record<string, any>) => {
            if (table !== 'agent_trust_scores') {
                return { data: null, error: null };
            }

            state.trustUpserts.push(payload);
            const current = state.trustRowsByAgent[payload.agent_id];
            state.trustRowsByAgent[payload.agent_id] = {
                trust_id: current?.trust_id ?? `trust-${payload.agent_id}`,
                trust_score: payload.trust_score ?? current?.trust_score ?? 0,
                total_decisions: payload.total_decisions ?? current?.total_decisions ?? 0,
                correct_decisions: current?.correct_decisions ?? 0,
                consecutive_failures: payload.consecutive_failures ?? current?.consecutive_failures ?? 0,
                trust_status: payload.trust_status ?? current?.trust_status ?? 'new',
            };

            return { data: null, error: null };
        }),
        insert: vi.fn(async (payload: Record<string, any>) => {
            if (table === 'degradation_alert_events') {
                state.alerts.push({
                    ...payload,
                    detected_at: payload.detected_at ?? new Date().toISOString(),
                });
                return { data: null, error: null };
            }

            if (table === 'agent_trust_snapshots' || table === 'agent_trust_audit') {
                return { data: null, error: null };
            }

            return { data: null, error: null };
        }),
        then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(execute()).then(resolve, reject),
    };

    function execute(): { data: any; error: any; count?: number | null } {
        if (table === 'fact_outcomes') {
            const agentId = filters.find((f) => f.column === 'agent_id')?.value;
            const rows = [...(state.factOutcomesByAgent[String(agentId)] ?? [])];

            if (selectOptions?.head && selectOptions?.count === 'exact') {
                const customerId = filters.find((f) => f.column === 'customer_id')?.value;
                const contextId = filters.find((f) => f.column === 'context_id')?.value;
                const key = `${customerId}|${contextId}`;
                return { data: null, error: null, count: state.contextOutcomeCounts[key] ?? 0 };
            }

            const limited = limitedTo !== null ? rows.slice(0, limitedTo) : rows;
            return { data: limited, error: null };
        }

        if (table === 'agent_trust_scores') {
            const agentId = String(filters.find((f) => f.column === 'agent_id')?.value ?? '');
            const row = state.trustRowsByAgent[agentId] ?? null;

            if (pendingUpdate) {
                state.trustUpdates.push({
                    payload: pendingUpdate,
                    filters: filters
                        .filter((f) => f.op === 'eq')
                        .map((f) => ({ column: f.column, value: f.value })),
                });

                if (row) {
                    const totalDecisionFilter = filters.find((f) => f.column === 'total_decisions');
                    const passesTotalFilter = totalDecisionFilter
                        ? row.total_decisions === totalDecisionFilter.value
                        : true;

                    if (passesTotalFilter) {
                        state.trustRowsByAgent[agentId] = {
                            ...row,
                            trust_score: pendingUpdate.trust_score ?? row.trust_score,
                            trust_status: pendingUpdate.trust_status ?? row.trust_status,
                        };
                    }
                }

                return { data: null, error: null };
            }

            if (!row) return { data: [], error: null };

            if (selected.includes('trust_id')) {
                return { data: [row], error: null };
            }
            if (selected.includes('total_decisions') && selected.includes('trust_status')) {
                return {
                    data: [{ total_decisions: row.total_decisions, trust_status: row.trust_status }],
                    error: null,
                };
            }
            if (selected.trim() === 'trust_status') {
                return { data: [{ trust_status: row.trust_status }], error: null };
            }

            return { data: [row], error: null };
        }

        if (table === 'dim_contexts') {
            const customerId = filters.find((f) => f.column === 'customer_id')?.value;
            const issueType = filters.find((f) => f.column === 'issue_type')?.value;
            const key = `${customerId}|${issueType}`;
            const contextId = state.contextsByCustomerIssue[key];
            return {
                data: contextId ? [{ context_id: contextId }] : [],
                error: null,
            };
        }

        if (table === 'degradation_alert_events') {
            let rows = [...state.alerts];
            for (const filter of filters) {
                if (filter.op === 'eq') {
                    rows = rows.filter((row) => row[filter.column] === filter.value);
                }
                if (filter.op === 'gte') {
                    rows = rows.filter((row) => {
                        if (!row[filter.column]) return false;
                        return String(row[filter.column]) >= String(filter.value);
                    });
                }
                if (filter.op === 'ilike') {
                    const needle = String(filter.value).toLowerCase().replace(/%/g, '').replace(/"/g, '');
                    rows = rows.filter((row) => String(row[filter.column] ?? '').toLowerCase().includes(needle));
                }
            }

            const result = limitedTo !== null ? rows.slice(0, limitedTo) : rows;
            return { data: result, error: null };
        }

        throw new Error(`Unexpected table in mock query: ${table}`);
    }

    return query;
}

function wireSupabaseMocks(state: MockState): void {
    vi.mocked(supabase.from).mockImplementation((table: string) => createSupabaseQuery(table, state));

    vi.mocked(supabase.rpc).mockImplementation(async (fn: string, args?: Record<string, any>) => {
        state.rpcCalls.push({ fn, args: args ?? {} });

        if (fn === 'detect_coordinated_failures') {
            return { data: [], error: null };
        }

        if (fn === 'update_trust_and_audit') {
            const agentId = String(args?.p_agent_id ?? '');
            const current = state.trustRowsByAgent[agentId];
            if (current) {
                state.trustRowsByAgent[agentId] = {
                    ...current,
                    trust_score: args?.p_trust_score ?? current.trust_score,
                    total_decisions: args?.p_total_decisions ?? current.total_decisions,
                    correct_decisions: args?.p_correct_decisions ?? current.correct_decisions,
                    consecutive_failures: args?.p_consecutive_failures ?? current.consecutive_failures,
                    trust_status: args?.p_trust_status ?? current.trust_status,
                };
            }
            return { data: null, error: null };
        }

        return { data: null, error: null };
    });
}

function baseParams(overrides: Partial<Parameters<typeof orchestrateOutcome>[0]> = {}): Parameters<typeof orchestrateOutcome>[0] {
    return {
        agentId: 'agent-1',
        customerId: 'cust-1',
        outcomeId: 'outcome-1',
        actionId: 'action-1',
        actionName: 'resolve_ticket',
        contextId: 'ctx-1',
        issueType: 'billing',
        finalSuccess: true,
        finalOutcomeScore: 1,
        ...overrides,
    };
}

async function flushBackgroundWork(): Promise<void> {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

describe('Outcome orchestrator invariants', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('preserves protected status during live trust upsert and still updates numeric score', async () => {
        const state = makeBaseState();
        wireSupabaseMocks(state);

        state.trustRowsByAgent['agent-1'] = {
            trust_id: 't-1',
            trust_score: 0.45,
            total_decisions: 20,
            correct_decisions: 9,
            consecutive_failures: 6,
            trust_status: 'sandbox',
        };

        state.contextsByCustomerIssue['cust-1|billing'] = 'ctx-1';
        state.contextOutcomeCounts['cust-1|ctx-1'] = 5;

        state.factOutcomesByAgent['agent-1'] = Array.from({ length: 20 }, () => ({ success: true }));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        await orchestrateOutcome(baseParams({ finalSuccess: false, finalOutcomeScore: 0 }));
        await flushBackgroundWork();

        expect(state.trustUpserts.length).toBeGreaterThan(0);
        const upsert = state.trustUpserts[state.trustUpserts.length - 1];
        expect(upsert.trust_status).toBe('sandbox');
        expect(upsert.trust_score).toBeGreaterThan(0.6);

        const warningMessages = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
        expect(warningMessages.some((msg) => msg.includes('skipping status overwrite'))).toBe(true);

        warnSpy.mockRestore();
    });

    it('maps weighted score 0.63 to trusted in live trust upsert', async () => {
        const state = makeBaseState();
        wireSupabaseMocks(state);

        state.trustRowsByAgent['agent-1'] = {
            trust_id: 't-1',
            trust_score: 0.5,
            total_decisions: 100,
            correct_decisions: 50,
            consecutive_failures: 0,
            trust_status: 'probation',
        };

        state.contextsByCustomerIssue['cust-1|billing'] = 'ctx-1';
        state.contextOutcomeCounts['cust-1|ctx-1'] = 12;

        const recent = [true, true, true, true, true, true, false, false, false, false];
        const rest = [
            ...Array.from({ length: 59 }, () => true),
            ...Array.from({ length: 31 }, () => false),
        ];

        state.factOutcomesByAgent['agent-1'] = [...recent, ...rest].map((success) => ({ success }));

        await orchestrateOutcome(baseParams());
        await flushBackgroundWork();

        expect(state.trustUpserts.length).toBeGreaterThan(0);
        const upsert = state.trustUpserts[state.trustUpserts.length - 1];

        expect(upsert.trust_score).toBe(0.63);
        expect(upsert.trust_status).toBe('trusted');
    });

    it('deduplicates silent failure degradation alerts by action within 24h', async () => {
        const state = makeBaseState();
        wireSupabaseMocks(state);

        state.trustRowsByAgent['agent-1'] = {
            trust_id: 't-1',
            trust_score: 0.7,
            total_decisions: 40,
            correct_decisions: 28,
            consecutive_failures: 0,
            trust_status: 'trusted',
        };

        state.contextsByCustomerIssue['cust-1|billing'] = 'ctx-1';
        state.contextOutcomeCounts['cust-1|ctx-1'] = 3;

        state.factOutcomesByAgent['agent-1'] = Array.from({ length: 20 }, () => ({ success: true }));

        await orchestrateOutcome(baseParams({ outcomeId: 'outcome-1', finalSuccess: true, finalOutcomeScore: 0.2 }));
        await orchestrateOutcome(baseParams({ outcomeId: 'outcome-2', finalSuccess: true, finalOutcomeScore: 0.1 }));

        const degradationAlerts = state.alerts.filter(
            (a) => a.alert_type === 'degradation' && a.customer_id === 'cust-1' && a.action_id === 'action-1'
        );

        expect(degradationAlerts).toHaveLength(1);
    });

    it('deduplicates context drift per context type so different types still alert within 24h', async () => {
        const state = makeBaseState();
        wireSupabaseMocks(state);

        state.trustRowsByAgent['agent-1'] = {
            trust_id: 't-1',
            trust_score: 0.6,
            total_decisions: 10,
            correct_decisions: 6,
            consecutive_failures: 0,
            trust_status: 'trusted',
        };

        state.factOutcomesByAgent['agent-1'] = Array.from({ length: 10 }, () => ({ success: true }));

        await orchestrateOutcome(baseParams({ outcomeId: 'outcome-1', issueType: 'billing', finalSuccess: false, finalOutcomeScore: null }));
        await orchestrateOutcome(baseParams({ outcomeId: 'outcome-2', issueType: 'technical_bug', finalSuccess: false, finalOutcomeScore: null }));

        const contextDriftAlerts = state.alerts.filter((a) => a.alert_type === 'context_drift');

        expect(contextDriftAlerts).toHaveLength(2);
        expect(contextDriftAlerts.some((a) => String(a.message).includes('"billing"'))).toBe(true);
        expect(contextDriftAlerts.some((a) => String(a.message).includes('"technical_bug"'))).toBe(true);
    });
});
