import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth.js', () => ({
    authMiddleware: async (c: any, next: any) => {
        c.set('customer_id', 'cust-1');
        await next();
    },
    devAuthMiddleware: async (c: any, next: any) => {
        c.set('customer_id', 'cust-1');
        await next();
    },
}));

vi.mock('../middleware/rate-limit.js', () => ({
    rateLimitMiddleware: () => async (_c: any, next: any) => {
        await next();
    },
}));

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
    },
}));

import discrepancyRoute from '../routes/discrepancy.js';
import { supabase } from '../lib/supabase.js';

function makeApp(): Hono {
    const app = new Hono();
    app.route('/v1/discrepancies', discrepancyRoute);
    return app;
}

describe('discrepancy route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('GET / — returns empty array when no discrepancies', async () => {
        (supabase.from as any).mockImplementation((table: string) => {
            expect(table).toBe('dim_discrepancy_log');
            const chain: any = {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
            return chain;
        });

        const app = makeApp();
        const res = await app.request('/v1/discrepancies', { method: 'GET' });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    test('GET / — returns unresolved discrepancies only (resolved=false filter)', async () => {
        const eqCalls: Array<[string, unknown]> = [];

        (supabase.from as any).mockImplementation((_table: string) => {
            const chain: any = {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockImplementation((column: string, value: unknown) => {
                    eqCalls.push([column, value]);
                    return chain;
                }),
                order: vi.fn().mockResolvedValue({
                    data: [{ discrepancy_id: 'd1', resolved: false }],
                    error: null,
                }),
            };
            return chain;
        });

        const app = makeApp();
        const res = await app.request('/v1/discrepancies', { method: 'GET' });

        expect(res.status).toBe(200);
        expect(eqCalls).toContainEqual(['resolved', false]);
    });

    test('GET /summary — returns correct by_type counts', async () => {
        (supabase.from as any).mockImplementation((_table: string) => {
            const chain: any = {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
            };
            chain.eq.mockImplementation((column: string, value: unknown) => {
                if (column === 'resolved' && value === false) {
                    return Promise.resolve({
                        data: [
                            { discrepancy_type: 'expired_no_signal' },
                            { discrepancy_type: 'expired_no_signal' },
                            { discrepancy_type: 'outcome_mismatch' },
                        ],
                        error: null,
                    });
                }
                return chain;
            });
            return chain;
        });

        const app = makeApp();
        const res = await app.request('/v1/discrepancies/summary', { method: 'GET' });
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.total).toBe(3);
        expect(body.by_type).toEqual({
            expired_no_signal: 2,
            outcome_mismatch: 1,
        });
    });

    test('POST /detect — detects expired_no_signal and inserts row', async () => {
        let pendingCallCount = 0;
        const inserted: any[] = [];

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'dim_pending_signal_registrations') {
                const chain: any = {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    lt: vi.fn().mockImplementation(() => Promise.resolve({
                        data: [{
                            registration_id: 'r1',
                            outcome_id: 'o1',
                            event_type: 'charge.refund.updated',
                            platform: 'stripe',
                            expiry_at: '2026-01-01T00:00:00.000Z',
                            resolved: false,
                        }],
                        error: null,
                    })),
                };
                chain.eq.mockImplementation(() => {
                    return chain;
                });
                chain.select.mockImplementation(() => {
                    pendingCallCount += 1;
                    if (pendingCallCount === 1) {
                        return chain;
                    }
                    return {
                        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
                    };
                });
                return chain;
            }

            if (table === 'dim_discrepancy_log') {
                const chain: any = {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                    insert: vi.fn().mockImplementation((payload: any) => {
                        inserted.push(payload);
                        return Promise.resolve({ error: null });
                    }),
                };
                return chain;
            }

            return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnThis(),
                not: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
        });

        const app = makeApp();
        const res = await app.request('/v1/discrepancies/detect', { method: 'POST' });
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.detected).toBe(1);
        expect(body.cases).toEqual({ expired: 1, mismatch: 0, low_confidence: 0 });
        expect(inserted.length).toBe(1);
        expect(inserted[0].discrepancy_type).toBe('expired_no_signal');
    });

    test('POST /detect — skips duplicate (already logged unresolved row)', async () => {
        let pendingCallCount = 0;
        const inserted: any[] = [];

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'dim_pending_signal_registrations') {
                const chain: any = {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    lt: vi.fn().mockResolvedValue({
                        data: [{
                            registration_id: 'r1',
                            outcome_id: 'o1',
                            event_type: 'deployment.status_changed',
                            platform: 'github',
                            expiry_at: '2026-01-01T00:00:00.000Z',
                            resolved: false,
                        }],
                        error: null,
                    }),
                };
                chain.select.mockImplementation(() => {
                    pendingCallCount += 1;
                    if (pendingCallCount === 1) {
                        return chain;
                    }
                    return {
                        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
                    };
                });
                return chain;
            }

            if (table === 'dim_discrepancy_log') {
                return {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockResolvedValue({ data: [{ discrepancy_id: 'd-existing' }], error: null }),
                    insert: vi.fn().mockImplementation((payload: any) => {
                        inserted.push(payload);
                        return Promise.resolve({ error: null });
                    }),
                };
            }

            return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnThis(),
                not: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
        });

        const app = makeApp();
        const res = await app.request('/v1/discrepancies/detect', { method: 'POST' });
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.detected).toBe(0);
        expect(body.cases).toEqual({ expired: 0, mismatch: 0, low_confidence: 0 });
        expect(inserted.length).toBe(0);
    });

    test('PATCH /:id/resolve — marks row resolved; returns 404 for unknown id', async () => {
        (supabase.from as any).mockImplementation((_table: string) => ({
            update: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        select: vi.fn().mockResolvedValue({ data: [{ discrepancy_id: 'd1' }], error: null }),
                    }),
                }),
            }),
        }));

        const app = makeApp();

        const okRes = await app.request('/v1/discrepancies/d1/resolve', { method: 'PATCH' });
        expect(okRes.status).toBe(204);

        (supabase.from as any).mockImplementation((_table: string) => ({
            update: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        select: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                }),
            }),
        }));

        const notFoundRes = await app.request('/v1/discrepancies/missing/resolve', { method: 'PATCH' });
        const body = await notFoundRes.json() as any;

        expect(notFoundRes.status).toBe(404);
        expect(body.code).toBe('NOT_FOUND');
    });
});
