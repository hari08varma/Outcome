/**
 * Layerinfinite — middleware/auth.ts
 * ══════════════════════════════════════════════════════════════
 * API key authentication middleware for Hono.
 *
 * Validates X-API-Key → agent lookup in dim_agents.
 * Sets: agent_id, customer_id, agent_name, customer_tier
 *
 * DEV BYPASS: Only active when BOTH conditions are met:
 *   NODE_ENV === 'development' AND LAYERINFINITE_DEV_BYPASS === 'true'
 * If LAYERINFINITE_DEV_BYPASS=true in production → hard crash (refuse to start).
 * ══════════════════════════════════════════════════════════════
 */

import { Context, Next } from 'hono';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';

// TTL reduced to 60s for security:
// Revoked keys must be rejected within 1 minute.
// PERFORMANCE NOTE: At 1000 req/min (enterprise tier),
// 60s TTL = ~16.7 DB auth reads/sec worst case
// (assumes zero cache hits on new keys).
// Benchmark with k6 before enterprise onboarding.
// Consider per-tier TTL (free=60s, pro=120s, enterprise=300s)
// if auth becomes a DB bottleneck under load.
// The 15-min cache was premature optimization at the
// expense of security — do not revert without load data.
const AUTH_CACHE_TTL_MS = 60 * 1000;

interface AgentAuth {
    agent_id: string;
    customer_id: string;
    agent_name: string;
    agent_type: string;
    llm_model: string | null;
    customer_tier: string;
    expires_at: number;
}

const authCache = new Map<string, AgentAuth>();

// Evict expired entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60_000;
setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of authCache.entries()) {
        if (entry.expires_at < now) {
            authCache.delete(key);
            evicted++;
        }
    }
    if (evicted > 0) {
        console.info(`[cache-cleanup] Evicted ${evicted} expired entries from authCache`);
    }
}, CLEANUP_INTERVAL_MS).unref();

setInterval(() => {
    console.info(`[cache-size] authCache: ${authCache.size} entries`);
}, 15 * 60_000).unref();

// AUTH RULE: This middleware accepts ONLY agent API keys (format: layerinfinite_XXXX).
// Supabase JWTs (format: eyJhbG...) are NOT valid here and return a 400 with a
// helpful error. Dashboard pages MUST use useAgentApiKey() hook, never getSession().

/**
 * Hashes an incoming API key to compare against database records.
 *
 * Algorithm: SHA-256
 * Rationale: MD5 is cryptographically broken. bcrypt is strictly for passwords
 *   because its intentional slowness causes DoS vulnerabilities on API limits.
 *   HMAC-SHA256 (or fast SHA-256) is industry standard for API token validation.
 * Date of fix: 2026-03-14
 */
function hashKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function invalidateAuthCacheByAgentId(agentId: string) {
    for (const [key, val] of authCache.entries()) {
        if (val.agent_id === agentId) {
            authCache.delete(key);
        }
    }
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
    // ── DEV BYPASS — NEVER active in production ────────────────
    if (process.env.NODE_ENV === 'development' &&
        process.env.LAYERINFINITE_DEV_BYPASS === 'true') {
        console.warn('⚠️  DEV BYPASS ACTIVE — NEVER deploy with this enabled');
        c.set('agent_id', process.env.DEV_AGENT_ID ?? 'd0000000-0000-0000-0000-000000000001');
        c.set('customer_id', process.env.DEV_CUSTOMER_ID ?? 'a0000000-0000-0000-0000-000000000001');
        c.set('agent_name', 'dev-bypass-agent');
        c.set('customer_tier', 'enterprise');
        await next();
        return;
    }

    const apiKey = c.req.header('X-API-Key') ?? c.req.header('Authorization')?.replace('Bearer ', '');

    if (!apiKey) {
        return c.json(
            { error: 'Missing API key. Provide X-API-Key header.', code: 'MISSING_API_KEY' },
            401
        );
    }

    // Detect Supabase JWT tokens sent by mistake — give a helpful error instead of
    // silently failing with INVALID_API_KEY (which is confusing for dashboard users).
    if (apiKey.startsWith('eyJ')) {
        return c.json(
            {
                error: 'JWT tokens are not valid for agent API routes. Use your agent API key.',
                hint: 'Find your API key in Settings → API Keys',
                code: 'WRONG_AUTH_TYPE',
            },
            400
        );
    }

    // Check cache first
    const cached = authCache.get(hashKey(apiKey));
    if (cached && cached.expires_at > Date.now()) {
        c.set('agent_id', cached.agent_id);
        c.set('customer_id', cached.customer_id);
        c.set('agent_name', cached.agent_name);
        c.set('customer_tier', cached.customer_tier);
        await next();
        return;
    }

    // Validate against database — join dim_customers for tier
    const { data, error } = await supabase
        .from('dim_agents')
        .select(`
            agent_id, customer_id, agent_name, agent_type, llm_model,
            is_active, api_key_hash,
            dim_customers!inner(tier)
        `)
        .eq('api_key_hash', hashKey(apiKey))
        .eq('is_active', true)
        .maybeSingle();

    if (error) {
        console.error('[auth] DB error:', error.message);
        return c.json({ error: 'Authentication service unavailable', code: 'AUTH_ERROR' }, 503);
    }

    if (!data) {
        return c.json(
            { error: 'Invalid or inactive API key', code: 'INVALID_API_KEY' },
            401
        );
    }

    const customerTier = (data as any).dim_customers?.tier ?? 'pro';

    // Cache the result
    authCache.set(hashKey(apiKey), {
        agent_id: data.agent_id,
        customer_id: data.customer_id,
        agent_name: data.agent_name,
        agent_type: data.agent_type,
        llm_model: data.llm_model,
        customer_tier: customerTier,
        expires_at: Date.now() + AUTH_CACHE_TTL_MS,
    });

    c.set('agent_id', data.agent_id);
    c.set('customer_id', data.customer_id);
    c.set('agent_name', data.agent_name);
    c.set('customer_tier', customerTier);

    await next();
}

/**
 * Development auth: accepts the service role key as the API key.
 * ONLY active when NODE_ENV !== 'production'.
 * Injects the demo agent/customer for testing.
 */
export async function devAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
    if (process.env.NODE_ENV === 'production') {
        return authMiddleware(c, next);
    }

    const apiKey = c.req.header('X-API-Key') ?? c.req.header('Authorization')?.replace('Bearer ', '');

    if (!apiKey && process.env.NODE_ENV !== 'production') {
        return c.json(
            { error: 'Missing API key. Set X-API-Key header. For dev: set LAYERINFINITE_DEV_API_KEY env var.', code: 'MISSING_API_KEY' },
            401
        );
    }

    if (apiKey && apiKey === process.env.LAYERINFINITE_DEV_API_KEY) {
        // Inject demo agent — ONLY in development
        c.set('agent_id', 'd0000000-0000-0000-0000-000000000001');
        c.set('customer_id', 'a0000000-0000-0000-0000-000000000001');
        c.set('agent_name', 'payment-bot-1 (dev)');
        c.set('customer_tier', 'enterprise');
        await next();
        return;
    }

    return authMiddleware(c, next);
}
