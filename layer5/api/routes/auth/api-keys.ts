/**
 * Layerinfinite — routes/auth/api-keys.ts
 * ══════════════════════════════════════════════════════════════
 * API key management for authenticated human users.
 *
 * GET    /  → List customer's API keys (prefix only, never full key)
 * POST   /  → Generate new API key (returns full key ONCE)
 * DELETE /:key_id → Deactivate an API key (soft delete for audit trail)
 *
 * Auth: Supabase JWT via userAuthMiddleware (NOT agent API key auth).
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';

export const apiKeysRouter = new Hono();

/**
 * Generate a cryptographically random API key.
 * Format: layerinfinite_<32 random hex chars>
 */
function generateApiKey(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `layerinfinite_${hex}`;
}

/**
 * Hash an API key for storage.
 * Uses SHA-256 — same key always produces the same hash.
 */
async function hashApiKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Schema ────────────────────────────────────────────────────
const CreateKeyBody = z.object({
    name: z.string().min(1).max(255),
});

// ── GET / — list all keys for customer ────────────────────────
apiKeysRouter.get('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    const { data, error } = await supabase
        .from('dim_agents')
        .select('agent_id, agent_name, api_key_hash, is_active, created_at')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false });

    if (error) {
        return c.json({ error: 'Failed to fetch API keys', details: error.message }, 500);
    }

    const keys = (data ?? []).map(row => ({
        key_id: row.agent_id,
        name: row.agent_name,
        prefix: row.api_key_hash ? row.api_key_hash.slice(0, 8) + '...' : null,
        is_active: row.is_active,
        created_at: row.created_at,
    }));

    return c.json({ keys });
});

// ── POST / — generate new API key ────────────────────────────
apiKeysRouter.post('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    let body: z.infer<typeof CreateKeyBody>;
    try {
        body = CreateKeyBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    // Generate the key
    const plainKey = generateApiKey();
    const keyHash = await hashApiKey(plainKey);

    // Create a dim_agents record for this key
    const { data, error } = await supabase
        .from('dim_agents')
        .insert({
            agent_name: body.name,
            agent_type: 'api-key',
            customer_id: customerId,
            api_key_hash: keyHash,
            is_active: true,
        })
        .select('agent_id, agent_name, created_at')
        .single();

    if (error) {
        return c.json({ error: 'Failed to create API key', details: error.message }, 500);
    }

    // Return the full key ONCE — it is never stored or retrievable again
    return c.json({
        api_key: plainKey,
        agent_id: data.agent_id,
        agent_name: data.agent_name,
        created_at: data.created_at,
        warning: 'Save this API key now — it cannot be shown again. This is the only credential you need. Never hardcode agent_id or customer_id in your application.',
    }, 201);
});

// ── DELETE /:key_id — deactivate an API key ───────────────────
apiKeysRouter.delete('/:key_id', async (c) => {
    const customerId = c.get('customer_id') as string;
    const keyId = c.req.param('key_id');

    // Verify the key belongs to this customer before deactivating
    const { data: existing, error: lookupError } = await supabase
        .from('dim_agents')
        .select('agent_id, customer_id, is_active')
        .eq('agent_id', keyId)
        .maybeSingle();

    if (lookupError) {
        return c.json({ error: 'Failed to look up key', details: lookupError.message }, 500);
    }

    if (!existing) {
        return c.json({ error: 'API key not found', code: 'NOT_FOUND' }, 404);
    }

    if (existing.customer_id !== customerId) {
        return c.json({ error: 'API key not found', code: 'NOT_FOUND' }, 404);
    }

    if (!existing.is_active) {
        return c.json({ error: 'API key is already deactivated', code: 'ALREADY_DEACTIVATED' }, 409);
    }

    // Soft deactivate — preserve audit trail
    const { error: updateError } = await supabase
        .from('dim_agents')
        .update({ is_active: false })
        .eq('agent_id', keyId);

    if (updateError) {
        return c.json({ error: 'Failed to deactivate key', details: updateError.message }, 500);
    }

    // After successful deletion from Supabase:
    const { invalidateAuthCacheByAgentId } = await import('../../middleware/auth.js');
    invalidateAuthCacheByAgentId(keyId);
    // This gives instant revocation for the 
    // current API server instance.
    // Note: Does not invalidate cache on OTHER 
    // server instances (if horizontally scaled).
    // 60s TTL is the safety net for that case.

    return c.json({ success: true, key_id: keyId, message: 'API key deactivated' });
});
