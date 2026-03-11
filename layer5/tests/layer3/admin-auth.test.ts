/**
 * Layer5 — Unit Tests: Admin Authentication
 * Tests the admin-auth middleware and reinstate-agent logic.
 * Run: npx vitest run tests/layer3/admin-auth.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from '../../api/middleware/admin-auth.js';

// Mock supabase client
vi.mock('../../api/lib/supabase.js', () => {
    return {
        supabase: {
            from: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(),
            update: vi.fn().mockReturnThis(),
            insert: vi.fn().mockReturnThis(),
        }
    };
});

import { supabase } from '../../api/lib/supabase.js';
import { reinstateAgentRouter } from '../../api/routes/admin/reinstate-agent.js';

describe('Admin Auth Middleware', () => {

    // We create a dummy app to test the middleware
    const app = new Hono();

    // Mock upstream auth setting customer_id
    app.use('/auth-provided', async (c, next) => {
        c.set('customer_id', 'cust-A');
        await next();
    });

    app.use('/no-auth', async (c, next) => {
        // Does not set customer_id
        await next();
    });

    app.use('*', adminAuthMiddleware);

    app.get('/auth-provided', (c) => c.json({ ok: true }));
    app.get('/no-auth', (c) => c.json({ ok: true }));

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('unauthenticated request (no customer_id) → 401', async () => {
        const req = new Request('http://localhost/no-auth');
        const res = await app.fetch(req);

        expect(res.status).toBe(401);
        const json = await res.json() as any;
        expect(json.code).toBe('UNAUTHORIZED');
    });

    it('standard API key (not customer_admin) → 403', async () => {
        // Mock DB returning standard user
        vi.mocked(supabase.maybeSingle).mockResolvedValueOnce({
            data: { customer_id: 'cust-A', config: { role: 'user' } },
            error: null
        } as any);

        const req = new Request('http://localhost/auth-provided');
        const res = await app.fetch(req);

        expect(res.status).toBe(403);
        const json = await res.json() as any;
        expect(json.code).toBe('FORBIDDEN');
    });

    it('customer_admin key → 200', async () => {
        // Mock DB returning admin user
        vi.mocked(supabase.maybeSingle).mockResolvedValueOnce({
            data: { customer_id: 'cust-A', config: { role: 'customer_admin' } },
            error: null
        } as any);

        const req = new Request('http://localhost/auth-provided');
        const res = await app.fetch(req);

        expect(res.status).toBe(200);
        const json = await res.json() as any;
        expect(json.ok).toBe(true);
    });
});

describe('Reinstate Agent Endpoint', () => {

    const app = new Hono();
    // Bypass auth for route testing, inject customer_id
    app.use('*', async (c, next) => {
        c.set('customer_id', 'cust-A');
        await next();
    });
    app.route('/reinstate-agent', reinstateAgentRouter);

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reinstate non-suspended agent → 400', async () => {
        // Mock dim_agents lookup (success)
        vi.mocked(supabase.maybeSingle).mockResolvedValueOnce({
            data: { agent_id: 'agent-1', agent_name: 'Bot', customer_id: 'cust-A' },
            error: null
        } as any);

        // Mock agent_trust_scores lookup (returns probation, not suspended)
        vi.mocked(supabase.maybeSingle).mockResolvedValueOnce({
            data: { trust_score: 0.4, trust_status: 'probation', consecutive_failures: 0 },
            error: null
        } as any);

        const req = new Request('http://localhost/reinstate-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: '12345678-1234-4234-b234-123456789012', reinstated_by: 'admin@test.com' })
        });
        const res = await app.fetch(req);

        expect(res.status).toBe(400);
        const json = await res.json() as any;
        expect(json.code).toBe('INVALID_STATE');
        expect(json.error).toBe('Agent is not currently suspended');
    });

    it('reinstate suspended agent → 200 + probation status', async () => {
        // Mock dim_agents lookup
        vi.mocked(supabase.maybeSingle).mockResolvedValueOnce({
            data: { agent_id: 'agent-1', agent_name: 'Bot', customer_id: 'cust-A' },
            error: null
        } as any);

        // Mock agent_trust_scores lookup (suspended)
        vi.mocked(supabase.maybeSingle).mockResolvedValueOnce({
            data: { trust_score: 0.1, trust_status: 'suspended', consecutive_failures: 5 },
            error: null
        } as any);

        // Mock update
        vi.mocked(supabase.update).mockReturnValueOnce({
            eq: vi.fn().mockResolvedValue({ error: null })
        } as any);

        // Mock insert
        vi.mocked(supabase.insert).mockResolvedValueOnce({ error: null } as any);

        const req = new Request('http://localhost/reinstate-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: '12345678-1234-4234-b234-123456789012', reinstated_by: 'admin@test.com' })
        });
        const res = await app.fetch(req);

        expect(res.status).toBe(200);
        const json = await res.json() as any;
        expect(json.new_status).toBe('probation');
        expect(json.new_score).toBe(0.4);
        expect(json.reinstated).toBe(true);
    });
});
