/**
 * Layerinfinite — middleware/rate-limit.ts
 * ══════════════════════════════════════════════════════════════
 * Tiered token-bucket rate limiter (in-memory, per-API-key).
 *
 * Tier limits (from dim_customers.tier, set by auth middleware):
 *   Free/Default: 200 req/min + 20 req/sec burst
 *   Pro:          1000 req/min + 50 req/sec burst
 *   Enterprise:   5000 req/min + 200 req/sec burst
 *
 * Headers returned on every response:
 *   X-RateLimit-Limit     → max requests per window
 *   X-RateLimit-Remaining → remaining in current window
 *   X-RateLimit-Reset     → epoch seconds when window resets
 *   Retry-After           → seconds until retry (429 only)
 * ══════════════════════════════════════════════════════════════
 */

import { Context, Next } from 'hono';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';

// ── Tiered limits ─────────────────────────────────────────────
interface TierLimits {
    maxPerMin: number;
    burstLimit: number;
}

const TIER_LIMITS: Record<string, TierLimits> = {
    free: { maxPerMin: 200, burstLimit: 20 },
    standard: { maxPerMin: 200, burstLimit: 20 },
    pro: { maxPerMin: 1000, burstLimit: 50 },
    enterprise: { maxPerMin: 5000, burstLimit: 200 },
};

const DEFAULT_LIMITS: TierLimits = { maxPerMin: 200, burstLimit: 20 };
const RATE_LIMIT_DB_TIMEOUT_MS = parseInt(process.env.RATE_LIMIT_DB_TIMEOUT_MS ?? '250', 10);

/**
 * Fail-open design:
 * If the persistent rate limit store (Supabase) is down or times out,
 * we log a warning and explicitly ALLOW the request. 
 * Enterprise APIs should never block critical traffic because quota telemetry is slow.
 */
export function rateLimitMiddleware() {
    return async (c: Context, next: Next): Promise<Response | void> => {
        // Identify by API key
        const rawKey = c.req.header('X-API-Key')
            ?? c.req.header('Authorization')?.replace('Bearer ', '')
            ?? c.req.header('x-forwarded-for')
            ?? 'anonymous';

        const apiKeyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

        // Get tier from auth middleware (set on context)
        const tier = (c.get('customer_tier') as string) ?? 'free';
        const limits = TIER_LIMITS[tier] ?? DEFAULT_LIMITS;
        const maxTokens = limits.maxPerMin;

        const now = Date.now();
        let tokens = maxTokens;

        try {
            // Read rate limit state with bounded latency budget
            const fetchPromise = supabase
                .from('rate_limit_buckets')
                .select('tokens, last_refill_at')
                .eq('api_key_hash', apiKeyHash)
                .maybeSingle();

            const timeoutPromise = new Promise<{ error: { message: string } }>((_, reject) =>
                setTimeout(() => reject(new Error(`Rate limit read timeout (>${RATE_LIMIT_DB_TIMEOUT_MS}ms)`)), RATE_LIMIT_DB_TIMEOUT_MS)
            );

            // Fetch racing the latency budget
            const { data, error } = (await Promise.race([fetchPromise, timeoutPromise])) as any;

            if (error) {
                console.warn(`[rate-limit] Supabase error: ${error.message} — FAILING OPEN`);
            } else if (data) {
                // Compute token refill based on last_refill_at timestamp delta
                const lastRefillMs = new Date(data.last_refill_at).getTime();
                const deltaMs = Math.max(0, now - lastRefillMs);
                const refillRate = maxTokens / 60_000; // tokens per ms

                tokens = Math.min(maxTokens, data.tokens + (deltaMs * refillRate));
            }
        } catch (err: any) {
            if (typeof err?.message === 'string' && err.message.includes('Rate limit read timeout')) {
                console.info(`[rate-limit] Read timeout (${RATE_LIMIT_DB_TIMEOUT_MS}ms) — FAILING OPEN`);
            } else {
                console.warn(`[rate-limit] DB Exception: ${err.message} — FAILING OPEN`);
            }
            // Tokens remains at maxTokens: request is allowed through
        }

        // ── Enforce Per-minute Window ──────────────────────────────
        if (tokens < 1) {
            const refillRate = maxTokens / 60_000;
            const msToNextToken = (1 - tokens) / refillRate;
            const retryAfterSec = Math.ceil(msToNextToken / 1000) || 1;

            c.header('Retry-After', String(retryAfterSec));
            c.header('X-RateLimit-Limit', String(maxTokens));
            c.header('X-RateLimit-Remaining', '0');
            c.header('X-RateLimit-Reset', String(Math.ceil((now + msToNextToken) / 1000)));

            return c.json(
                {
                    error: `Rate limit exceeded. Max ${maxTokens} req/min for ${tier} tier.`,
                    code: 'RATE_LIMIT_EXCEEDED',
                    tier: tier,
                    retry_after: retryAfterSec,
                },
                429
            );
        }

        // Consume 1 token
        const newTokens = tokens - 1;

        // Async fire-and-forget Atomic UPSERT (Latency path offloaded)
        Promise.resolve(
            supabase.from('rate_limit_buckets').upsert({
                api_key_hash: apiKeyHash,
                tokens: newTokens,
                last_refill_at: new Date(now).toISOString(),
                tier: tier,
                updated_at: new Date(now).toISOString()
            }, { onConflict: 'api_key_hash' })
        ).then(({ error }) => {
            if (error) console.error('[rate-limit] Upsert failed:', error.message);
        }).catch(err => console.error('[rate-limit] Upsert exception:', err));

        // Estimate when bucket hits max capacity for reset header
        const refillRateMs = maxTokens / 60_000;
        const msToFull = (maxTokens - newTokens) / refillRateMs;

        c.header('X-RateLimit-Limit', String(maxTokens));
        c.header('X-RateLimit-Remaining', String(Math.floor(newTokens)));
        c.header('X-RateLimit-Reset', String(Math.ceil((now + msToFull) / 1000)));

        await next();
    };
}
