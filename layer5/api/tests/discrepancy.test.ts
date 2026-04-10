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
        const inserted: any[] = [];

        /**
         * Proper thenable chain — every builder method returns `self`,
         * AND the chain implements .then()/.catch()/.finally() so it can
         * be `await`-ed directly (handles .not().not() and .select().eq() terminals).
         */
        const makeThenable = (resolveValue: { data: any; error: any }) => {
            const p = Promise.resolve(resolveValue);
            const chain: any = {
                select: vi.fn(),
                eq:     vi.fn(),
                not:    vi.fn(),
                in:     vi.fn(),
                lt:     vi.fn(),
                is:     vi.fn(),
                order:  vi.fn(),
                limit:  vi.fn(),
                maybeSingle: vi.fn().mockResolvedValue(resolveValue),
                single:      vi.fn().mockResolvedValue(resolveValue),
                insert: vi.fn().mockResolvedValue({ error: null }),
                then:    p.then.bind(p),
                catch:   p.catch.bind(p),
                finally: p.finally.bind(p),
            };
            chain.select.mockReturnValue(chain);
            chain.eq.mockReturnValue(chain);
            chain.not.mockReturnValue(chain);
            chain.in.mockReturnValue(chain);
            chain.lt.mockReturnValue(chain);
            chain.is.mockReturnValue(chain);
            chain.order.mockReturnValue(chain);
            chain.limit.mockReturnValue(chain);
            return chain;
        };

        // 1st query to dim_pending_signal_registrations: expired rows (.lt terminates)
        const expiredRow = {
            registration_id: 'r1', outcome_id: 'o1',
            event_type: 'charge.refund.updated', platform: 'stripe',
            expiry_at: '2026-01-01T00:00:00.000Z', resolved: false,
        };
        const pendingExpiredChain = makeThenable({ data: [expiredRow], error: null });
        pendingExpiredChain.lt = vi.fn().mockResolvedValue({ data: [expiredRow], error: null });

        // 2nd query: all registrations (.select.eq terminates via thenable)
        const pendingAllChain = makeThenable({ data: [], error: null });

        let pendingSelectCount = 0;
        const pendingChain: any = {
            select: vi.fn().mockImplementation(() => {
                pendingSelectCount++;
                return pendingSelectCount === 1 ? pendingExpiredChain : pendingAllChain;
            }),
        };

        // dim_discrepancy_log: dedup IN query returns empty → new insert tracked
        const discChain = makeThenable({ data: [], error: null });
        discChain.insert = vi.fn().mockImplementation((payload: any) => {
            const rows = Array.isArray(payload) ? payload : [payload];
            inserted.push(...rows);
            return Promise.resolve({ error: null });
        });

        // fact_outcomes: all queries return empty (no cross-event, pending, inconsistency)
        const factsChain = makeThenable({ data: [], error: null });

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'dim_pending_signal_registrations') return pendingChain;
            if (table === 'dim_discrepancy_log')             return discChain;
            if (table === 'dim_signal_contracts')            return makeThenable({ data: [], error: null });
            if (table === 'dim_actions')                     return makeThenable({ data: [], error: null });
            if (table === 'fact_outcomes')                   return factsChain;
            return makeThenable({ data: [], error: null });
        });

        const app = makeApp();
        const res = await app.request('/v1/discrepancies/detect', { method: 'POST' });
        const body = await res.json() as any;
        if (res.status === 500) console.log('[DEBUG detect test 1]', body);

        expect(res.status).toBe(200);
        expect(body.detected).toBe(1);
        expect(body.cases).toEqual({ expired: 1, mismatch: 0, low_confidence: 0 });
        expect(inserted.length).toBe(1);
        expect(inserted[0].discrepancy_type).toBe('expired_no_signal');
    });

    test('POST /detect — skips duplicate (already logged unresolved row)', async () => {
        const inserted: any[] = [];

        const makeThenable = (resolveValue: { data: any; error: any }) => {
            const p = Promise.resolve(resolveValue);
            const chain: any = {
                select: vi.fn(),
                eq:     vi.fn(),
                not:    vi.fn(),
                in:     vi.fn(),
                lt:     vi.fn(),
                is:     vi.fn(),
                order:  vi.fn(),
                limit:  vi.fn(),
                maybeSingle: vi.fn().mockResolvedValue(resolveValue),
                single:      vi.fn().mockResolvedValue(resolveValue),
                insert: vi.fn().mockResolvedValue({ error: null }),
                then:    p.then.bind(p),
                catch:   p.catch.bind(p),
                finally: p.finally.bind(p),
            };
            chain.select.mockReturnValue(chain);
            chain.eq.mockReturnValue(chain);
            chain.not.mockReturnValue(chain);
            chain.in.mockReturnValue(chain);
            chain.lt.mockReturnValue(chain);
            chain.is.mockReturnValue(chain);
            chain.order.mockReturnValue(chain);
            chain.limit.mockReturnValue(chain);
            return chain;
        };

        // expired pending chain — one row found
        const expiredRow = {
            registration_id: 'r1', outcome_id: 'o1',
            event_type: 'deployment.status_changed', platform: 'github',
            expiry_at: '2026-01-01T00:00:00.000Z', resolved: false,
        };
        const pendingExpiredChain = makeThenable({ data: [expiredRow], error: null });
        pendingExpiredChain.lt = vi.fn().mockResolvedValue({ data: [expiredRow], error: null });
        const pendingAllChain   = makeThenable({ data: [], error: null });

        let pendingSelectCount = 0;
        const pendingChain: any = {
            select: vi.fn().mockImplementation(() => {
                pendingSelectCount++;
                return pendingSelectCount === 1 ? pendingExpiredChain : pendingAllChain;
            }),
        };

        // dim_discrepancy_log — dedup check finds existing row (skip insert)
        const discChain = makeThenable({ data: [{ outcome_id: 'o1' }], error: null });
        discChain.limit = vi.fn().mockResolvedValue({ data: [{ discrepancy_id: 'd-existing' }], error: null });
        discChain.insert = vi.fn().mockImplementation((payload: any) => {
            const rows = Array.isArray(payload) ? payload : [payload];
            inserted.push(...rows);
            return Promise.resolve({ error: null });
        });

        const factsChain = makeThenable({ data: [], error: null });

        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'dim_pending_signal_registrations') return pendingChain;
            if (table === 'dim_discrepancy_log')             return discChain;
            if (table === 'dim_signal_contracts')            return makeThenable({ data: [], error: null });
            if (table === 'dim_actions')                     return makeThenable({ data: [], error: null });
            if (table === 'fact_outcomes')                   return factsChain;
            return makeThenable({ data: [], error: null });
        });

        const app = makeApp();
        const res = await app.request('/v1/discrepancies/detect', { method: 'POST' });
        const body = await res.json() as any;
        if (res.status === 500) console.log('[DEBUG detect test 2]', body);

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
