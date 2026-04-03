import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
    __resetRateLimitStateForTests,
    rateLimitMiddleware,
} from '../middleware/rate-limit.js';

function createApp(): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
        const customerId = c.req.header('x-customer-id');
        if (customerId) {
            c.set('customer_id' as any, customerId);
        }
        await next();
    });

    app.use('*', rateLimitMiddleware);
    app.get('/v1/test', (c) => c.json({ ok: true }));

    return app;
}

describe('rateLimitMiddleware', () => {
    const prevWindow = process.env.RATE_LIMIT_WINDOW_MS;
    const prevMax = process.env.RATE_LIMIT_MAX;

    beforeEach(() => {
        process.env.RATE_LIMIT_WINDOW_MS = '60000';
        process.env.RATE_LIMIT_MAX = '5';
        __resetRateLimitStateForTests();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'));
    });

    afterEach(() => {
        if (prevWindow === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
        else process.env.RATE_LIMIT_WINDOW_MS = prevWindow;

        if (prevMax === undefined) delete process.env.RATE_LIMIT_MAX;
        else process.env.RATE_LIMIT_MAX = prevMax;

        __resetRateLimitStateForTests();
        vi.useRealTimers();
    });

    it('Under limit: passes through', async () => {
        const app = createApp();

        for (let i = 0; i < 5; i++) {
            const res = await app.request('/v1/test', {
                method: 'GET',
                headers: { 'x-customer-id': 'cust-1' },
            });
            expect(res.status).toBe(200);
        }
    });

    it('Over limit: returns 429 with retry_after_ms > 0', async () => {
        const app = createApp();

        for (let i = 0; i < 5; i++) {
            const res = await app.request('/v1/test', {
                method: 'GET',
                headers: { 'x-customer-id': 'cust-1' },
            });
            expect(res.status).toBe(200);
        }

        const blocked = await app.request('/v1/test', {
            method: 'GET',
            headers: { 'x-customer-id': 'cust-1' },
        });

        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).not.toBeNull();

        const json = await blocked.json() as any;
        expect(json.error).toBe('RATE_LIMIT_EXCEEDED');
        expect(json.retry_after_ms).toBeGreaterThan(0);
    });

    it('Different customers have independent counters', async () => {
        const app = createApp();

        for (let i = 0; i < 6; i++) {
            await app.request('/v1/test', {
                method: 'GET',
                headers: { 'x-customer-id': 'A' },
            });
        }

        const otherCustomer = await app.request('/v1/test', {
            method: 'GET',
            headers: { 'x-customer-id': 'B' },
        });

        expect(otherCustomer.status).toBe(200);
    });

    it('Window resets after expiry', async () => {
        const app = createApp();

        for (let i = 0; i < 6; i++) {
            await app.request('/v1/test', {
                method: 'GET',
                headers: { 'x-customer-id': 'cust-1' },
            });
        }

        vi.setSystemTime(new Date(Date.now() + 60_001));

        const res = await app.request('/v1/test', {
            method: 'GET',
            headers: { 'x-customer-id': 'cust-1' },
        });

        expect(res.status).toBe(200);
    });
});
