import { Context, Next } from 'hono';

interface RateLimitWindow {
    count: number;
    windowStart: number;
}

const rateLimitWindows = new Map<string, RateLimitWindow>();

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 300;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

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

setInterval(() => {
    const now = Date.now();
    const maxAgeMs = getWindowMs() * 2;

    for (const [customerId, entry] of rateLimitWindows.entries()) {
        if (now - entry.windowStart > maxAgeMs) {
            rateLimitWindows.delete(customerId);
        }
    }
}, CLEANUP_INTERVAL_MS).unref();

export function __resetRateLimitStateForTests(): void {
    rateLimitWindows.clear();
}

export const rateLimitMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
    const customerId = c.get('customer_id') as string | undefined;

    // Auth middleware handles missing customer context.
    if (!customerId) {
        await next();
        return;
    }

    const now = Date.now();
    const windowMs = getWindowMs();
    const maxRequests = getMaxRequests();

    const current = rateLimitWindows.get(customerId);

    if (!current || now - current.windowStart >= windowMs) {
        rateLimitWindows.set(customerId, {
            count: 1,
            windowStart: now,
        });
        await next();
        return;
    }

    if (current.count >= maxRequests) {
        const retryAfterMs = Math.max(0, windowMs - (now - current.windowStart));
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
    }

    current.count += 1;
    rateLimitWindows.set(customerId, current);

    await next();
};
