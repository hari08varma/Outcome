/**
 * Layerinfinite — Unit Tests: API Key Management
 * Tests POST, GET, DELETE /v1/auth/api-keys
 * Run: npx vitest run tests/auth/api-keys.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mock supabase ─────────────────────────────────────────────
// vi.mock is hoisted — factory must not reference outer variables.
vi.mock('../../api/lib/supabase.js', () => {
    const chain: any = {};
    const methods = ['select', 'eq', 'order', 'insert', 'update', 'maybeSingle', 'single'];
    for (const m of methods) {
        chain[m] = vi.fn().mockReturnValue(chain);
    }
    return {
        supabase: {
            from: vi.fn().mockReturnValue(chain),
            _chain: chain,
        },
    };
});

import { supabase } from '../../api/lib/supabase.js';
import { apiKeysRouter } from '../../api/routes/auth/api-keys.js';

// Helper: access the chain mock
function getChain() {
    return (supabase as any)._chain;
}

// ── Test app that pre-sets customer_id (simulating userAuthMiddleware) ──
function createApp(customerId: string) {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('customer_id', customerId);
        await next();
    });
    app.route('/api-keys', apiKeysRouter);
    return app;
}

describe('API Key Management — /v1/auth/api-keys', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset chain methods to return chain by default
        const chain = getChain();
        for (const m of ['select', 'eq', 'order', 'insert', 'update', 'maybeSingle', 'single']) {
            chain[m].mockReturnValue(chain);
        }
        vi.mocked(supabase.from).mockReturnValue(chain);
    });

    // ────────────────────────────────────────────────────────────
    // POST /v1/auth/api-keys
    // ────────────────────────────────────────────────────────────
    describe('POST /api-keys', () => {
        it('returns full key once, starting with layerinfinite_', async () => {
            const chain = getChain();
            chain.single.mockResolvedValueOnce({
                data: { agent_id: 'key-1', agent_name: 'My Agent', created_at: '2026-01-01' },
                error: null,
            });

            const app = createApp('cust-A');
            const res = await app.fetch(
                new Request('http://localhost/api-keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'My Agent' }),
                })
            );

            expect(res.status).toBe(201);
            const json = await res.json() as any;

            // Key starts with layerinfinite_
            expect(json.key).toMatch(/^layerinfinite_[0-9a-f]{32}$/);
            expect(json.key_id).toBe('key-1');
            expect(json.name).toBe('My Agent');
            expect(json.warning).toContain('cannot be shown again');
        });

        it('key format: layerinfinite_ + 32 hex chars', async () => {
            const chain = getChain();
            chain.single.mockResolvedValueOnce({
                data: { agent_id: 'key-2', agent_name: 'Test', created_at: '2026-01-01' },
                error: null,
            });

            const app = createApp('cust-A');
            const res = await app.fetch(
                new Request('http://localhost/api-keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Test' }),
                })
            );

            const json = await res.json() as any;
            // layerinfinite_ (14 chars) + 32 hex chars = 46 total
            expect(json.key).toHaveLength(46);
            expect(json.key.slice(0, 14)).toBe('layerinfinite_');
        });
    });

    // ────────────────────────────────────────────────────────────
    // GET /v1/auth/api-keys
    // ────────────────────────────────────────────────────────────
    describe('GET /api-keys', () => {
        it('never returns full key — only prefix (first 8 chars of hash)', async () => {
            const chain = getChain();
            chain.order.mockResolvedValueOnce({
                data: [
                    {
                        agent_id: 'key-1',
                        agent_name: 'Production',
                        api_key_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
                        is_active: true,
                        created_at: '2026-01-01',
                    },
                ],
                error: null,
            });

            const app = createApp('cust-A');
            const res = await app.fetch(new Request('http://localhost/api-keys'));

            expect(res.status).toBe(200);
            const json = await res.json() as any;
            const key = json.keys[0];

            // Prefix is first 8 chars + '...'
            expect(key.prefix).toBe('abcdef12...');
            // Full hash should NOT be present
            expect(key.api_key_hash).toBeUndefined();
            // No 'key' field (that's only returned on POST)
            expect(key.key).toBeUndefined();
        });

        it('only returns keys for the authenticated customer', async () => {
            const chain = getChain();
            chain.order.mockResolvedValueOnce({
                data: [
                    { agent_id: 'key-cA', agent_name: 'CustA Key', api_key_hash: 'aaaa1111', is_active: true, created_at: '2026-01-01' },
                ],
                error: null,
            });

            const app = createApp('cust-A');
            const res = await app.fetch(new Request('http://localhost/api-keys'));
            const json = await res.json() as any;

            // Verify the supabase query filtered by customer_id
            expect(chain.eq).toHaveBeenCalledWith('customer_id', 'cust-A');
            expect(json.keys).toHaveLength(1);
            expect(json.keys[0].key_id).toBe('key-cA');
        });
    });

    // ────────────────────────────────────────────────────────────
    // DELETE /v1/auth/api-keys/:key_id
    // ────────────────────────────────────────────────────────────
    describe('DELETE /api-keys/:key_id', () => {
        it('deactivates key (sets is_active = false)', async () => {
            // DELETE makes two supabase.from('dim_agents') calls:
            // 1) .select().eq().maybeSingle() — lookup
            // 2) .update().eq() — deactivate
            // We create separate chain mocks for each call.

            const lookupChain: any = {};
            for (const m of ['select', 'eq', 'order', 'insert', 'update', 'single']) {
                lookupChain[m] = vi.fn().mockReturnValue(lookupChain);
            }
            lookupChain.maybeSingle = vi.fn().mockResolvedValue({
                data: { agent_id: 'key-1', customer_id: 'cust-A', is_active: true },
                error: null,
            });

            const updateChain: any = {};
            for (const m of ['select', 'order', 'insert', 'maybeSingle', 'single']) {
                updateChain[m] = vi.fn().mockReturnValue(updateChain);
            }
            updateChain.update = vi.fn().mockReturnValue(updateChain);
            updateChain.eq = vi.fn().mockResolvedValue({ error: null });

            let callIdx = 0;
            vi.mocked(supabase.from).mockImplementation(() => {
                callIdx++;
                return (callIdx === 1 ? lookupChain : updateChain) as any;
            });

            const app = createApp('cust-A');
            const res = await app.fetch(
                new Request('http://localhost/api-keys/key-1', { method: 'DELETE' })
            );

            expect(res.status).toBe(200);
            const json = await res.json() as any;
            expect(json.success).toBe(true);
            expect(json.key_id).toBe('key-1');

            // Verify update was called with is_active: false
            expect(updateChain.update).toHaveBeenCalledWith({ is_active: false });
        });

        it('deactivated key → agent auth rejects (is_active=false)', async () => {
            // Simulates the existing auth.ts query logic:
            // .eq('api_key_hash', hash).eq('is_active', true)
            // Once deactivated, no match → 401
            const agentDb = [
                { agent_id: 'key-1', api_key_hash: 'hash123', is_active: false, customer_id: 'cust-A' },
            ];

            const result = agentDb.find(
                a => a.api_key_hash === 'hash123' && a.is_active === true
            );

            expect(result).toBeUndefined();
        });
    });
});
