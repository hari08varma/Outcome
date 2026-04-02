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

// ── In-memory burst tracker (per-process, per-API-key-hash) ─
// Burst is a per-second guard — no DB needed, no cross-process sync needed.
// Intentionally lost on process restart: burst windows are 1s, restart clears them.
interface BurstWindow {
    count: number;
    windowStart: number;  // ms timestamp
}
const burstWindows = new Map<string, BurstWindow>();

// Evict stale burst windows every 30s to prevent unbounded growth
setInterval(() => {
    const now = Date.now();
    for (const [key, w] of burstWindows.entries()) {
        if (now - w.windowStart > 1000) burstWindows.delete(key);
    }
}, 30_000).unref();

const DEFAULT_LIMITS: TierLimits = { maxPerMin: 200, burstLimit: 20 };
const parsedRateLimitDbTimeoutMs = Number.parseInt(process.env.RATE_LIMIT_DB_TIMEOUT_MS ?? '250', 10);
const RATE_LIMIT_DB_TIMEOUT_MS = Number.isFinite(parsedRateLimitDbTimeoutMs) && parsedRateLimitDbTimeoutMs > 0
    ? parsedRateLimitDbTimeoutMs
    : 250;

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

        // ── Enforce per-second burst limit (in-memory, fast path) ────
        const burstLimit = limits.burstLimit;
        const burstKey = apiKeyHash;   // already a SHA-256 hash
        const burstNow = Date.now();
        const burst = burstWindows.get(burstKey);

        if (burst && burstNow - burst.windowStart < 1000) {
            if (burst.count >= burstLimit) {
                c.header('X-RateLimit-Limit', String(maxTokens));
                c.header('X-RateLimit-Remaining', '0');
                c.header('Retry-After', '1');
                c.header('X-RateLimit-Reset', String(Math.ceil((burst.windowStart + 1000) / 1000)));
                return c.json(
                    {
                        error: `Burst limit exceeded. Max ${burstLimit} req/sec for ${tier} tier.`,
                        code: 'BURST_LIMIT_EXCEEDED',
                        tier,
                        retry_after: 1,
                    },
                    429
                );
            }
            burst.count++;
        } else {
            // New window or expired window — start fresh
            burstWindows.set(burstKey, { count: 1, windowStart: burstNow });
        }

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
            } else {
                // New bucket — check cardinality before allowing creation
                try {
                    const countResult = await Promise.race([
                        supabase.rpc('get_rate_limit_bucket_count'),
                        new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
                    ]);
                    const countError = (countResult as any)?.error as { message?: string } | undefined;
                    if (countError?.message) {
                        console.warn('[rate-limit] Capacity check RPC failed:', countError.message);
                    }
                    const approxCount = (countResult as any)?.data as number | null;
                    if (approxCount !== null && approxCount > 950_000) {
                        console.warn('[rate-limit] Store capacity critical — rejecting new bucket creation', { approxCount });
                        c.header('X-RateLimit-Limit', String(maxTokens));
                        c.header('X-RateLimit-Remaining', '0');
                        c.header('X-RateLimit-Reason', 'store_capacity_exhausted');
                        c.header('X-Rate-Limit-Reason', 'store_capacity_exhausted');
                        return c.json(
                            { error: 'Rate limit store at capacity. Try again later.', code: 'RATE_LIMIT_STORE_CAPACITY' },
                            503
                        );
                    }
                } catch {
                    // Capacity check failed — fail open, allow the request
                }
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
        // window_expiry: 60s from now — reaper removes rows where now() > expiry + 2min grace
        const windowExpiry = new Date(now + 60_000).toISOString();
        void (supabase.from('rate_limit_buckets').upsert({
            api_key_hash: apiKeyHash,
            tokens: newTokens,
            last_refill_at: new Date(now).toISOString(),
            tier: tier,
            updated_at: new Date(now).toISOString(),
            window_expiry: windowExpiry,
            last_touched: new Date(now).toISOString(),
        }, { onConflict: 'api_key_hash' }) as unknown as Promise<{ error: { message: string } | null }>)
            .then(({ error }) => {
                if (error) console.error('[rate-limit] Upsert failed:', error.message);
            })
            .catch((err: unknown) => console.error('[rate-limit] Upsert exception:', err));

        // Reset = when the NEXT token will be available (not when bucket is full).
        // If tokens remain, reset is already in the past — use now as floor.
        const refillRateMs = maxTokens / 60_000;
        const msToNextToken = newTokens >= 1 ? 0 : Math.ceil((1 - newTokens) / refillRateMs);

        c.header('X-RateLimit-Limit', String(maxTokens));
        c.header('X-RateLimit-Remaining', String(Math.floor(newTokens)));
        c.header('X-RateLimit-Reset', String(Math.ceil((now + msToNextToken) / 1000)));

        await next();
    };
}
