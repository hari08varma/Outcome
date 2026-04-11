import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        rpc: vi.fn(),
    },
}));

import {
    __resetRateLimitStateForTests,
    rateLimitMiddleware,
} from '../middleware/rate-limit.js';
import { supabase } from '../lib/supabase.js';

function createApp(): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
        const customerId = c.req.header('x-customer-id');
        const customerTier = c.req.header('x-customer-tier');
        if (customerId) c.set('customer_id' as any, customerId);
        if (customerTier) c.set('customer_tier' as any, customerTier);
        await next();
    });

    app.use('*', rateLimitMiddleware);
    app.get('/v1/test', (c) => c.json({ ok: true }));

    return app;
}

describe('rateLimitMiddleware (DB-backed)', () => {
    const prevWindow = process.env.RATE_LIMIT_WINDOW_MS;
    const prevMax = process.env.RATE_LIMIT_MAX;
    const prevFailOpen = process.env.RATE_LIMIT_FAIL_OPEN;

    beforeEach(() => {
        process.env.RATE_LIMIT_WINDOW_MS = '60000';
        process.env.RATE_LIMIT_MAX = '5';
        process.env.RATE_LIMIT_FAIL_OPEN = 'true';
        __resetRateLimitStateForTests();
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (prevWindow === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
        else process.env.RATE_LIMIT_WINDOW_MS = prevWindow;

        if (prevMax === undefined) delete process.env.RATE_LIMIT_MAX;
        else process.env.RATE_LIMIT_MAX = prevMax;

        if (prevFailOpen === undefined) delete process.env.RATE_LIMIT_FAIL_OPEN;
        else process.env.RATE_LIMIT_FAIL_OPEN = prevFailOpen;

        __resetRateLimitStateForTests();
    });

    it('allows request when backend returns allowed=true', async () => {
        vi.mocked((supabase as any).rpc).mockResolvedValueOnce({
            data: [{ allowed: true, retry_after_ms: 0 }],
            error: null,
        });

        const app = createApp();
        const res = await app.request('/v1/test', {
            method: 'GET',
            headers: {
                'x-customer-id': 'cust-1',
                'x-customer-tier': 'enterprise',
            },
        });

        expect(res.status).toBe(200);
        expect((supabase as any).rpc).toHaveBeenCalledWith(
            'consume_rate_limit_bucket',
            expect.objectContaining({
                p_window_ms: 60000,
                p_max_requests: 5,
                p_tier: 'enterprise',
            }),
        );
    });

    it('returns 429 with Retry-After when backend denies request', async () => {
        vi.mocked((supabase as any).rpc).mockResolvedValueOnce({
            data: [{ allowed: false, retry_after_ms: 15000 }],
            error: null,
        });

        const app = createApp();
        const res = await app.request('/v1/test', {
            method: 'GET',
            headers: { 'x-customer-id': 'cust-1' },
        });

        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('15');

        const json = await res.json() as any;
        expect(json.error).toBe('RATE_LIMIT_EXCEEDED');
        expect(json.retry_after_ms).toBe(15000);
    });

    it('bypasses limiter when customer context is missing', async () => {
        const app = createApp();
        const res = await app.request('/v1/test', { method: 'GET' });

        expect(res.status).toBe(200);
        expect((supabase as any).rpc).not.toHaveBeenCalled();
    });

    it('fails open on backend error when RATE_LIMIT_FAIL_OPEN=true', async () => {
        vi.mocked((supabase as any).rpc).mockResolvedValueOnce({
            data: null,
            error: { message: 'db unavailable' },
        });

        const app = createApp();
        const res = await app.request('/v1/test', {
            method: 'GET',
            headers: { 'x-customer-id': 'cust-1' },
        });

        expect(res.status).toBe(200);
    });

    it('returns 503 on backend error when RATE_LIMIT_FAIL_OPEN=false', async () => {
        process.env.RATE_LIMIT_FAIL_OPEN = 'false';
        vi.mocked((supabase as any).rpc).mockResolvedValueOnce({
            data: null,
            error: { message: 'db unavailable' },
        });

        const app = createApp();
        const res = await app.request('/v1/test', {
            method: 'GET',
            headers: { 'x-customer-id': 'cust-1' },
        });

        expect(res.status).toBe(503);
        const json = await res.json() as any;
        expect(json.error).toBe('RATE_LIMIT_UNAVAILABLE');
    });
});
