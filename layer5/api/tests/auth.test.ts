import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// Mock the console methods so we don't dirty the test output with warnings
const originalWarn = console.warn;
beforeEach(() => {
    console.warn = vi.fn();
});
afterEach(() => {
    console.warn = originalWarn;
    vi.restoreAllMocks();
});

describe('Dev Auth Middleware Bypass Isolation', () => {

    it('devAuthMiddleware rejects LAYER5_INTERNAL_SECRET as API key', async () => {
        // Step 1: Mock environment configuration
        vi.stubEnv('LAYER5_INTERNAL_SECRET', 'secret-abc');
        vi.stubEnv('LAYER5_DEV_API_KEY', 'dev-xyz');

        // Setup minimal app to mount the exact dev auth middleware behavior route
        const app = new Hono();

        // Dynamically import the middleware so it reads the mocked env vars fresh
        const { devAuthMiddleware } = await import('../middleware/auth.js');

        app.use('*', devAuthMiddleware);
        app.get('/test', (c) => {
            // Should never be reached if devAuthMiddleware fails and next() blocks,
            // or if it falls through it shouldn't have set the bypass agent
            const agentId = c.get('agent_id');
            const customerTier = c.get('customer_tier');
            return c.json({ agentId, customerTier });
        });

        // Step 2: Inject the internal secret 
        // We simulate `devAuthMiddleware` falling through to the real `authMiddleware`
        // Since `authMiddleware` hits the real DB, we mock `authMiddleware` earlier, 
        // OR we just verify the `devAuthMiddleware` explicitly didn't set context properties

        const req = new Request('http://localhost/test', {
            headers: { 'X-API-Key': 'secret-abc' } // Sending INTERNAL_SECRET
        });

        // Manually intercept to test the middleware behavior in isolation
        // If it rejects the bypass, agent_id remains undefined
        const cMock: any = {
            req: {
                header: (name: string) => req.headers.get(name) || undefined
            },
            set: vi.fn(),
            json: vi.fn(),
        };
        const nextMock = vi.fn();

        await devAuthMiddleware(cMock, nextMock);

        // Assert: agent_id is NOT set on context (vi.mock wasn't called with it)
        expect(cMock.set).not.toHaveBeenCalledWith('agent_id', 'd0000000-0000-0000-0000-000000000001');

        // The middleware would just fall through to the next handler (the real auth)
        expect(nextMock).toHaveBeenCalled();
    });

    it('devAuthMiddleware accepts LAYER5_DEV_API_KEY in dev', async () => {
        // Step 1: Mock dev bypass explicit conditions
        vi.stubEnv('NODE_ENV', 'development');
        vi.stubEnv('LAYER5_DEV_BYPASS', 'true');
        vi.stubEnv('LAYER5_DEV_API_KEY', 'dev-xyz');

        const { devAuthMiddleware } = await import('../middleware/auth.js');

        // Step 2: Inject the explicit dev API bypass key
        const req = new Request('http://localhost/test', {
            headers: { 'X-API-Key': 'dev-xyz' }  // Sending DEV_API_KEY
        });

        const cMock: any = {
            req: {
                header: (name: string) => req.headers.get(name) || undefined
            },
            set: vi.fn(),
            json: vi.fn(),
        };
        const nextMock = vi.fn();

        await devAuthMiddleware(cMock, nextMock);

        // Assert: response passes through
        expect(nextMock).toHaveBeenCalled();

        // Assert: Enterprise context successfully embedded by the dev bypass
        expect(cMock.set).toHaveBeenCalledWith('agent_id', 'd0000000-0000-0000-0000-000000000001');
        expect(cMock.set).toHaveBeenCalledWith('customer_tier', 'enterprise');
    });

});
