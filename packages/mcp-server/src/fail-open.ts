/**
 * LayerInfinite MCP Server — fail-open.ts
 * ══════════════════════════════════════════════════════════════
 * 3-Layer failure protection with circuit breaker.
 *
 * Layer 1: Async logging fails → write to local disk queue → retry with backoff
 * Layer 2: LI API unreachable → fail open → agent executes directly → queue on disk
 * Layer 3: Everything fails → agent executes as if LI doesn't exist → zero footprint
 *
 * Circuit breaker: 3 consecutive upstream failures → open for 60s → half-open probe
 * ══════════════════════════════════════════════════════════════
 */

import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FailOpenState, OutcomePayload } from './types.js';
import { logger } from './logger.js';

const log = logger.forTool('fail-open');

const QUEUE_DIR = '.li-queue';
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_OPEN_MS = 60_000;
const MAX_QUEUE_RETRY_MS = 300_000; // 5 min max retry
const BASE_BACKOFF_MS = 1000;

let processQueueRunning = false;

export function createFailOpenState(): FailOpenState {
  return {
    upstreamFailures: new Map(),
    circuitBreakerOpen: new Map(),
    lastHealthCheck: new Map(),
    totalRequests: 0,
    passthroughRequests: 0,
  };
}

/** Ensure queue directory exists. Returns the directory path. */
async function ensureQueueDir(): Promise<string> {
  await mkdir(QUEUE_DIR, { recursive: true });
  return QUEUE_DIR;
}

// ── Layer 1: Disk queue for failed async logs ────────────────

export interface QueuedEntry {
  id: string;
  payload: OutcomePayload;
  attempts: number;
  firstAttempt: number;
  lastAttempt: number;
}

/**
 * Write an outcome to the local disk queue when LI API is unreachable.
 * Each entry is a separate JSON file for atomicity.
 */
export async function enqueueOutcome(payload: OutcomePayload): Promise<void> {
  const dir = await ensureQueueDir();
  const id = randomUUID();
  const entry: QueuedEntry = {
    id,
    payload,
    attempts: 0,
    firstAttempt: Date.now(),
    lastAttempt: Date.now(),
  };
  const path = join(dir, `${id}.json`);
  await writeFile(path, JSON.stringify(entry) + '\n', 'utf-8');
  log.info('Outcome queued to disk', { id, action: payload.action_name });
}

/** List all queued entries sorted by first attempt (oldest first). */
export async function listQueuedEntries(): Promise<QueuedEntry[]> {
  const { readdir } = await import('node:fs/promises');
  const dir = await ensureQueueDir();
  const entries: QueuedEntry[] = [];
  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        entries.push(JSON.parse(content) as QueuedEntry);
      } catch {
        // Corrupt queue file — skip
      }
    }
  } catch {
    // Directory doesn't exist yet — no entries
  }
  return entries.sort((a, b) => a.firstAttempt - b.firstAttempt);
}

/** Remove a queued entry by ID. */
export async function dequeueEntry(id: string): Promise<void> {
  const dir = await ensureQueueDir();
  try {
    await unlink(join(dir, `${id}.json`));
  } catch {
    // Already removed — fine
  }
}

/** Update attempts on a queued entry. */
export async function updateQueuedEntry(entry: QueuedEntry): Promise<void> {
  const dir = await ensureQueueDir();
  await writeFile(join(dir, `${entry.id}.json`), JSON.stringify(entry) + '\n', 'utf-8');
}

// ── Layer 2 & 3: Circuit breaker ─────────────────────────────

/** Record a failure for an upstream server. Returns true if circuit breaker just opened. */
export function recordUpstreamFailure(state: FailOpenState, upstreamName: string): boolean {
  const current = state.upstreamFailures.get(upstreamName) ?? 0;
  const next = current + 1;
  state.upstreamFailures.set(upstreamName, next);

  if (next >= CIRCUIT_BREAKER_THRESHOLD && !state.circuitBreakerOpen.get(upstreamName)) {
    state.circuitBreakerOpen.set(upstreamName, true);
    log.warn('Circuit breaker opened', { upstream: upstreamName, failures: next });
    return true;
  }
  return false;
}

/** Record a success — resets failure count and closes circuit breaker. */
export function recordUpstreamSuccess(state: FailOpenState, upstreamName: string): void {
  state.upstreamFailures.set(upstreamName, 0);
  if (state.circuitBreakerOpen.get(upstreamName)) {
    state.circuitBreakerOpen.set(upstreamName, false);
    log.info('Circuit breaker closed', { upstream: upstreamName });
  }
}

/** Probe half-open: check if enough time has passed to attempt a probe.
 *  Does NOT reset state — the caller must call recordUpstreamSuccess/Failure
 *  after the actual health check completes. */
export function probeCircuitBreaker(state: FailOpenState, upstreamName: string): boolean {
  const open = state.circuitBreakerOpen.get(upstreamName);
  if (!open) return false;

  const lastCheck = state.lastHealthCheck.get(upstreamName) ?? 0;
  if (Date.now() - lastCheck < CIRCUIT_BREAKER_OPEN_MS) return false;

  // Allow one probe through — caller is responsible for recording result
  state.circuitBreakerOpen.set(upstreamName, false);
  log.info('Circuit breaker half-open — probing', { upstream: upstreamName });
  return true;
}

/** Check if circuit breaker is open for an upstream. */
export function isCircuitOpen(state: FailOpenState, upstreamName: string): boolean {
  return state.circuitBreakerOpen.get(upstreamName) ?? false;
}

/** Update health check timestamp. */
export function updateHealthCheck(state: FailOpenState, upstreamName: string): void {
  state.lastHealthCheck.set(upstreamName, Date.now());
}

// ── Retry queue processor ────────────────────────────────────

export type QueueSender = (payload: OutcomePayload) => Promise<boolean>;

/**
 * Process the disk queue with exponential backoff.
 * Returns the number of entries successfully sent.
 */
export async function processQueue(send: QueueSender): Promise<number> {
  if (processQueueRunning) {
    log.debug('Queue processor already running — skipping');
    return 0;
  }
  processQueueRunning = true;

  try {
    const entries = await listQueuedEntries();
    let sent = 0;

    for (const entry of entries) {
      const elapsed = Date.now() - entry.firstAttempt;
      if (elapsed > MAX_QUEUE_RETRY_MS) {
        log.warn('Queue entry expired', { id: entry.id, elapsed_ms: elapsed });
        await dequeueEntry(entry.id);
        continue;
      }

      const success = await send(entry.payload);
      if (success) {
        await dequeueEntry(entry.id);
        sent++;
      } else {
        const updated: QueuedEntry = {
          ...entry,
          attempts: entry.attempts + 1,
          lastAttempt: Date.now(),
        };
        await updateQueuedEntry(updated);
      }
    }

    return sent;
  } finally {
    processQueueRunning = false;
  }
}

/**
 * Calculate backoff delay for a queue retry.
 * Exponential: min(base * 2^attempts, 5 min).
 */
export function backoffDelay(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts), MAX_QUEUE_RETRY_MS);
}

/** Get queue stats for monitoring. */
export async function getQueueStats(): Promise<{ count: number; oldestMs: number | null }> {
  const entries = await listQueuedEntries();
  return {
    count: entries.length,
    oldestMs: entries.length > 0 ? Date.now() - entries[0].firstAttempt : null,
  };
}

// ── Queue processor lifecycle ────────────────────────────────

/**
 * Start a periodic queue processor. Runs immediately on startup to drain any
 * entries left from a crash, then every `intervalMs` thereafter.
 * Returns a handle with `stop()` for clean shutdown.
 */
export function startQueueProcessor(
  send: QueueSender,
  intervalMs: number = 30_000,
): { stop: () => void } {
  // Drain on startup — catch crash leftovers immediately
  void processQueue(send);

  const timer = setInterval(() => {
    void processQueue(send);
  }, intervalMs);

  log.info('Queue processor started', { intervalMs });

  return {
    stop: () => {
      clearInterval(timer);
      log.info('Queue processor stopped');
    },
  };
}
