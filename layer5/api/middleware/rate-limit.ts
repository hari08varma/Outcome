import { Context, Next } from 'hono';
import crypto from 'node:crypto';

import { supabase } from '../lib/supabase.js';
import { OUTCOME_INGEST_WORKER_BYPASS_HEADER } from '../lib/outcome-ingest-queue.js';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 1000;
const DEFAULT_FAIL_OPEN = false; // fail-closed: return 429 when DB is unavailable

// Two-tier defaults for MCP gateway endpoints
const DEFAULT_TOOLS_LIST_MAX = 60;    // tools/list — cached, shouldn't hit often
const DEFAULT_TOOLS_CALL_MAX = 2000;  // tools/call — headroom for 1000/min sustained

function readPositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function getWindowMs(): number {
    return readPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
}

function getMaxRequests(): number {
    return readPositiveInt(process.env.RATE_LIMIT_MAX, DEFAULT_MAX_REQUESTS);
}

function getToolsListMax(): number {
    return readPositiveInt(process.env.RATE_LIMIT_TOOLS_LIST_MAX, DEFAULT_TOOLS_LIST_MAX);
}

function getToolsCallMax(): number {
    return readPositiveInt(process.env.RATE_LIMIT_TOOLS_CALL_MAX, DEFAULT_TOOLS_CALL_MAX);
}

/** Resolve the rate limit ceiling for a request path. */
function resolveMaxRequests(path: string): number {
    if (path.includes('/tools/list') || path.includes('/v1/get-scores') || path.includes('/v1/recommendations')) {
        return getToolsListMax();
    }
    if (path.includes('/tools/call') || path.includes('/v1/log-outcome') || path.includes('/v1/simulate')) {
        return getToolsCallMax();
    }
    return getMaxRequests();
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function shouldFailOpen(): boolean {
    return readBoolean(process.env.RATE_LIMIT_FAIL_OPEN, DEFAULT_FAIL_OPEN);
}

function normalizeTier(value: unknown): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'free' || normalized === 'pro' || normalized === 'enterprise') {
        return normalized;
    }
    return 'pro';
}

function buildBucketKey(customerId: string): string {
    return crypto
        .createHash('sha256')
        .update(`customer:${customerId}`)
        .digest('hex');
}

interface ConsumeRateLimitRow {
    allowed?: boolean;
    retry_after_ms?: number;
}

async function consumeRateLimitBucket(params: {
    customerId: string;
    customerTier: string;
    windowMs: number;
    maxRequests: number;
}): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const { data, error } = await supabase.rpc('consume_rate_limit_bucket', {
        p_bucket_key: buildBucketKey(params.customerId),
        p_window_ms: params.windowMs,
        p_max_requests: params.maxRequests,
        p_tier: params.customerTier,
    });

    if (error) {
        throw new Error(error.message);
    }

    const first = Array.isArray(data)
        ? (data[0] as ConsumeRateLimitRow | undefined)
        : (data as ConsumeRateLimitRow | null);

    if (!first || typeof first.allowed !== 'boolean') {
        throw new Error('Rate limiter RPC returned invalid payload');
    }

    return {
        allowed: first.allowed,
        retryAfterMs: Math.max(0, Number(first.retry_after_ms ?? 0)),
    };
}

export function __resetRateLimitStateForTests(): void {
    // no-op: DB-backed limiter has no in-process bucket state.
}

export const rateLimitMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
    // Internal Queue Loopback natively bypasses rate limiting, because the initial external request
    // that populated the array was already organically authenticated and rate-limited.
    if ((c.req.header(OUTCOME_INGEST_WORKER_BYPASS_HEADER) ?? '').trim() === '1') {
        await next();
        return;
    }

    const customerId = c.get('customer_id') as string | undefined;
    const customerTier = normalizeTier(c.get('customer_tier') as string | undefined);

    // Auth middleware handles missing customer context.
    if (!customerId) {
        await next();
        return;
    }

    const windowMs = getWindowMs();
    const maxRequests = resolveMaxRequests(c.req.path);

    try {
        const consumeResult = await consumeRateLimitBucket({
            customerId,
            customerTier,
            windowMs,
            maxRequests,
        });

        if (consumeResult.allowed) {
            await next();
            return;
        }

        const retryAfterMs = consumeResult.retryAfterMs > 0
            ? consumeResult.retryAfterMs
            : windowMs;
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

        c.header('Retry-After', String(retryAfterSeconds));
        return c.json(
            {
                error: 'RATE_LIMIT_EXCEEDED',
                message: `Too many requests. Limit: ${maxRequests}/min per customer.`,
                retry_after_ms: retryAfterMs,
            },
            429
        );
    } catch (err: any) {
        if (shouldFailOpen()) {
            console.warn('[rate-limit] backend unavailable, fail-open enabled:', err?.message ?? 'unknown error');
            await next();
            return;
        }

        // Fail-closed: return 429 to protect the system when DB is unavailable
        console.error('[rate-limit] backend unavailable, fail-closed — returning 429:', err?.message ?? 'unknown error');
        c.header('Retry-After', '60');
        return c.json(
            {
                error: 'RATE_LIMIT_UNAVAILABLE',
                message: 'Too many requests — rate limiter is temporarily unavailable.',
            },
            429,
        );
    }
};
