import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
    },
}));

vi.mock('../lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
}));

import { supabase } from '../lib/supabase.js';
import { invalidateCache } from '../lib/scoring.js';
import { outcomeFeedbackRouter } from '../routes/outcome-feedback.js';

function makeApp(): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
        c.set('customer_id', 'cust-1');
        await next();
    });

    app.route('/v1/outcome-feedback', outcomeFeedbackRouter);
    return app;
}

function makeUpdateChain(eqCount: number, terminalResult: any): any {
    const chain: any = {};
    chain.eq = vi.fn();
    for (let i = 0; i < eqCount - 1; i += 1) {
        chain.eq.mockReturnValueOnce(chain);
    }
    chain.eq.mockResolvedValueOnce(terminalResult);
    return chain;
}

describe('outcome-feedback route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('POST / — writes reconciliation status metadata and conflict discrepancy trace', async () => {
        const outcomeId = '11111111-1111-4111-8111-111111111111';
        let capturedUpdate: Record<string, unknown> | null = null;
        const insertedDiscrepancies: any[] = [];

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'fact_outcomes') {
                return {
                    select: vi.fn().mockImplementation((columns: string) => {
                        if (columns.includes('customer_id')) {
                            const selectChain: any = {
                                eq: vi.fn(),
                                maybeSingle: vi.fn().mockResolvedValue({
                                    data: {
                                        outcome_id: outcomeId,
                                        customer_id: 'cust-1',
                                        context_id: 'ctx-1',
                                        success: false,
                                        signal_pending: true,
                                        cross_event_status: null,
                                        action_id: 'act-1',
                                    },
                                    error: null,
                                }),
                            };
                            selectChain.eq.mockReturnValue(selectChain);
                            return selectChain;
                        }

                        if (columns.includes('agent_id')) {
                            const delayedChain: any = {
                                eq: vi.fn(),
                                single: vi.fn().mockResolvedValue({
                                    data: { success: false, action_id: 'act-1', agent_id: 'agent-1' },
                                    error: null,
                                }),
                            };
                            delayedChain.eq.mockReturnValue(delayedChain);
                            return delayedChain;
                        }

                        throw new Error(`Unexpected fact_outcomes select columns: ${columns}`);
                    }),
                    update: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
                        capturedUpdate = payload;
                        return makeUpdateChain(2, { error: null });
                    }),
                };
            }

            if (table === 'fact_outcome_feedback') {
                return {
                    insert: vi.fn().mockResolvedValue({ error: null }),
                };
            }

            if (table === 'dim_pending_signal_registrations') {
                return {
                    update: vi.fn().mockImplementation(() => makeUpdateChain(3, { error: null })),
                };
            }

            if (table === 'dim_discrepancy_log') {
                return {
                    select: vi.fn().mockImplementation(() => {
                        const selectChain: any = {
                            eq: vi.fn(),
                            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                        };
                        selectChain.eq.mockReturnValue(selectChain);
                        return selectChain;
                    }),
                    insert: vi.fn().mockImplementation((payload: any) => {
                        const rows = Array.isArray(payload) ? payload : [payload];
                        insertedDiscrepancies.push(...rows);
                        return Promise.resolve({ error: null });
                    }),
                };
            }

            if (table === 'degradation_alert_events') {
                return {
                    insert: vi.fn().mockResolvedValue({ error: null }),
                };
            }

            throw new Error(`Unexpected table in outcome-feedback test: ${table}`);
        });

        const app = makeApp();
        const res = await app.request('/v1/outcome-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                outcome_id: outcomeId,
                final_score: 0.82,
                business_outcome: 'resolved',
            }),
        });
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.execution_status).toBe('COMPLETED');
        expect(body.failure_reason_code).toBeNull();
        expect(body.failure_stage).toBeNull();
        expect(body.status_origin).toBe('reconciled_feedback');

        expect(capturedUpdate).not.toBeNull();
        expect(capturedUpdate?.execution_status).toBe('COMPLETED');
        expect(capturedUpdate?.status_origin).toBe('reconciled_feedback');
        expect(capturedUpdate?.failure_reason_code).toBeNull();
        expect(capturedUpdate?.failure_stage).toBeNull();

        expect(insertedDiscrepancies).toHaveLength(1);
        expect(insertedDiscrepancies[0].discrepancy_type).toBe('cross_event_conflict');
        expect(insertedDiscrepancies[0].reason_code).toBe('cross_event_feedback_conflict');
        expect(insertedDiscrepancies[0].trace_reason_code).toBe('cross_event_feedback_conflict');
        expect(insertedDiscrepancies[0].trace_stage).toBe('delayed_feedback');
        expect(insertedDiscrepancies[0].trace_gate).toBe('cross_event_status_conflict');
        expect(insertedDiscrepancies[0].source_execution_status).toBe('COMPLETED');
        expect(insertedDiscrepancies[0].source_status_origin).toBe('reconciled_feedback');
        expect(insertedDiscrepancies[0].trace_payload).toMatchObject({
            initial_success: false,
            final_score: 0.82,
        });

        expect(invalidateCache).toHaveBeenCalledWith('cust-1', 'ctx-1');
    });

    test('POST / — marks failed delayed feedback with failure trace metadata', async () => {
        const outcomeId = '22222222-2222-4222-8222-222222222222';
        let capturedUpdate: Record<string, unknown> | null = null;

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'fact_outcomes') {
                return {
                    select: vi.fn().mockImplementation((columns: string) => {
                        if (columns.includes('customer_id')) {
                            const selectChain: any = {
                                eq: vi.fn(),
                                maybeSingle: vi.fn().mockResolvedValue({
                                    data: {
                                        outcome_id: outcomeId,
                                        customer_id: 'cust-1',
                                        context_id: 'ctx-2',
                                        success: false,
                                        signal_pending: true,
                                        cross_event_status: null,
                                        action_id: 'act-2',
                                    },
                                    error: null,
                                }),
                            };
                            selectChain.eq.mockReturnValue(selectChain);
                            return selectChain;
                        }

                        if (columns.includes('agent_id')) {
                            const delayedChain: any = {
                                eq: vi.fn(),
                                single: vi.fn().mockResolvedValue({
                                    data: { success: false, action_id: 'act-2', agent_id: 'agent-2' },
                                    error: null,
                                }),
                            };
                            delayedChain.eq.mockReturnValue(delayedChain);
                            return delayedChain;
                        }

                        throw new Error(`Unexpected fact_outcomes select columns: ${columns}`);
                    }),
                    update: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
                        capturedUpdate = payload;
                        return makeUpdateChain(2, { error: null });
                    }),
                };
            }

            if (table === 'fact_outcome_feedback') {
                return {
                    insert: vi.fn().mockResolvedValue({ error: null }),
                };
            }

            if (table === 'dim_pending_signal_registrations') {
                return {
                    update: vi.fn().mockImplementation(() => makeUpdateChain(3, { error: null })),
                };
            }

            if (table === 'dim_discrepancy_log') {
                return {
                    select: vi.fn().mockImplementation(() => {
                        const selectChain: any = {
                            eq: vi.fn(),
                            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                        };
                        selectChain.eq.mockReturnValue(selectChain);
                        return selectChain;
                    }),
                    insert: vi.fn().mockResolvedValue({ error: null }),
                };
            }

            if (table === 'degradation_alert_events') {
                return {
                    insert: vi.fn().mockResolvedValue({ error: null }),
                };
            }

            throw new Error(`Unexpected table in outcome-feedback test: ${table}`);
        });

        const app = makeApp();
        const res = await app.request('/v1/outcome-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                outcome_id: outcomeId,
                final_score: 0.12,
                business_outcome: 'failed',
            }),
        });
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.execution_status).toBe('FAILED');
        expect(body.failure_reason_code).toBe('delayed_feedback_failed');
        expect(body.failure_stage).toBe('delayed_feedback');
        expect(body.status_origin).toBe('reconciled_feedback');

        expect(capturedUpdate).not.toBeNull();
        expect(capturedUpdate?.execution_status).toBe('FAILED');
        expect(capturedUpdate?.failure_reason_code).toBe('delayed_feedback_failed');
        expect(capturedUpdate?.failure_stage).toBe('delayed_feedback');
        expect(capturedUpdate?.status_origin).toBe('reconciled_feedback');
    });
});
