/**
 * Layer5 — middleware/rate-limit.ts
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

// ── Bucket store ──────────────────────────────────────────────
interface Bucket {
    count: number;
    resetAt: number;
    burstCount: number;
    burstAt: number;
}

const WINDOW_MS = 60_000;  // 1-minute window
const BURST_WINDOW = 1_000;   // 1-second burst window

const buckets = new Map<string, Bucket>();

// Cleanup stale buckets every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
        if (bucket.resetAt < now) buckets.delete(key);
    }
}, 5 * 60_000);

// ── Middleware ────────────────────────────────────────────────
export function rateLimitMiddleware() {
    return async (c: Context, next: Next): Promise<Response | void> => {
        // Identify by API key
        const apiKey = c.req.header('X-API-Key')
            ?? c.req.header('Authorization')?.replace('Bearer ', '')
            ?? c.req.header('x-forwarded-for')
            ?? 'anonymous';

        // Get tier from auth middleware (set on context)
        const tier = (c.get('customer_tier') as string) ?? 'standard';
        const limits = TIER_LIMITS[tier] ?? DEFAULT_LIMITS;
        const maxPerWindow = limits.maxPerMin;
        const burstLimit = limits.burstLimit;

        const now = Date.now();
        let bucket = buckets.get(apiKey);

        // ── Initialise or reset window ─────────────────────
        if (!bucket || bucket.resetAt <= now) {
            bucket = {
                count: 0,
                resetAt: now + WINDOW_MS,
                burstCount: 0,
                burstAt: now + BURST_WINDOW,
            };
        }

        // ── Burst protection ───────────────────────────────
        if (bucket.burstAt <= now) {
            bucket.burstCount = 0;
            bucket.burstAt = now + BURST_WINDOW;
        }
        bucket.burstCount++;

        if (bucket.burstCount > burstLimit) {
            buckets.set(apiKey, bucket);
            c.header('Retry-After', '1');
            c.header('X-RateLimit-Limit', String(maxPerWindow));
            c.header('X-RateLimit-Remaining', '0');
            c.header('X-RateLimit-Reset', String(Math.ceil(bucket.burstAt / 1000)));
            return c.json(
                { error: `Burst limit exceeded. Max ${burstLimit} requests/second.`, code: 'BURST_LIMIT' },
                429
            );
        }

        // ── Per-minute window ──────────────────────────────
        bucket.count++;
        buckets.set(apiKey, bucket);

        const remaining = Math.max(0, maxPerWindow - bucket.count);
        const resetSec = Math.ceil(bucket.resetAt / 1000);

        c.header('X-RateLimit-Limit', String(maxPerWindow));
        c.header('X-RateLimit-Remaining', String(remaining));
        c.header('X-RateLimit-Reset', String(resetSec));

        if (bucket.count > maxPerWindow) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            c.header('Retry-After', String(retryAfter));
            return c.json(
                {
                    error: `Rate limit exceeded. Max ${maxPerWindow} req/min for ${tier} tier.`,
                    code: 'RATE_LIMIT_EXCEEDED',
                    tier: tier,
                    retry_after: retryAfter,
                },
                429
            );
        }

        await next();
    };
}
