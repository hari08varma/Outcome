/**
 * Layer5 SDK — Retry logic with exponential backoff and jitter.
 *
 * Mirrors the Python SDK retry.py exactly.
 *
 * Retries on:
 *   - Layer5ServerError (5xx)
 *   - Layer5NetworkError (connection failures)
 *   - Layer5TimeoutError (request timed out)
 *   - Layer5RateLimitError (429 — respects retry_after header)
 *
 * Does NOT retry on:
 *   - Layer5AuthError (401) — won't succeed on retry
 *   - Layer5ValidationError (400) — won't succeed on retry
 *   - Layer5UnknownActionError — won't succeed on retry
 *   - Layer5AgentSuspendedError — won't succeed on retry
 */

/**
 * Calculate delay for attempt N with exponential backoff.
 *
 * attempt=0: ~500ms
 * attempt=1: ~1000ms
 * attempt=2: ~2000ms
 * attempt=3: ~4000ms
 * Capped at maxDelay. Jitter prevents thundering herd.
 */
export function exponentialBackoff(
  attempt: number,
  baseDelay = 500,
  maxDelay = 30_000,
  jitter = true
): number {
  const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
  if (!jitter) return delay;
  // Add up to 25% random jitter (0.75–1.25x)
  return delay * (0.75 + Math.random() * 0.5);
}

/**
 * Sleep for the given number of milliseconds.
 * Uses setTimeout — works in Node, Deno, Bun, browsers, and edge workers.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
