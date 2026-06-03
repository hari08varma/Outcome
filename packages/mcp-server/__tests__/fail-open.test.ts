import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createFailOpenState,
  enqueueOutcome,
  listQueuedEntries,
  dequeueEntry,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  probeCircuitBreaker,
  isCircuitOpen,
  updateHealthCheck,
  processQueue,
  backoffDelay,
  getQueueStats,
  startQueueProcessor,
} from '../src/fail-open.js';
import type { FailOpenState, OutcomePayload } from '../src/types.js';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const QUEUE_DIR = '.li-queue';

function makePayload(overrides: Partial<OutcomePayload> = {}): OutcomePayload {
  return {
    agent_id: 'agent-1', customer_id: 'cust-1', issue_type: 'build_failed',
    action_name: 'github_push', upstream_name: 'github',
    original_action: 'github_push', executed_action: 'github_push',
    mode: 'recommend', rerouted: false, success: true,
    response_time_ms: 100, timestamp: new Date().toISOString(),
    ingestion_source: 'mcp', environment: 'production',
    ...overrides,
  } as OutcomePayload;
}

describe('createFailOpenState', () => {
  it('creates empty state', () => {
    const state = createFailOpenState();
    expect(state.totalRequests).toBe(0);
    expect(state.passthroughRequests).toBe(0);
    expect(state.upstreamFailures.size).toBe(0);
    expect(state.circuitBreakerOpen.size).toBe(0);
  });
});

describe('circuit breaker', () => {
  let state: FailOpenState;

  beforeEach(() => { state = createFailOpenState(); });

  it('opens after threshold failures', () => {
    expect(recordUpstreamFailure(state, 'github')).toBe(false);
    expect(recordUpstreamFailure(state, 'github')).toBe(false);
    expect(recordUpstreamFailure(state, 'github')).toBe(true); // Opens on 3rd
    expect(isCircuitOpen(state, 'github')).toBe(true);
  });

  it('closes on success', () => {
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    expect(isCircuitOpen(state, 'github')).toBe(true);
    recordUpstreamSuccess(state, 'github');
    expect(isCircuitOpen(state, 'github')).toBe(false);
  });

  it('resets failure count on success', () => {
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    recordUpstreamSuccess(state, 'github');
    expect(recordUpstreamFailure(state, 'github')).toBe(false); // Count restarts at 1
    expect(recordUpstreamFailure(state, 'github')).toBe(false); // 2
    expect(recordUpstreamFailure(state, 'github')).toBe(true);  // 3 => open
  });

  it('tracks failures per upstream independently', () => {
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    expect(isCircuitOpen(state, 'github')).toBe(true);
    expect(isCircuitOpen(state, 'database')).toBe(false);
  });

  it('probeCircuitBreaker allows probe after timeout', () => {
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    expect(isCircuitOpen(state, 'github')).toBe(true);

    vi.useFakeTimers();
    updateHealthCheck(state, 'github');
    vi.advanceTimersByTime(61_000);
    expect(probeCircuitBreaker(state, 'github')).toBe(true);
    // Circuit is temporarily closed for the probe
    expect(isCircuitOpen(state, 'github')).toBe(false);
    vi.useRealTimers();
  });

  it('probeCircuitBreaker returns false before timeout', () => {
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    recordUpstreamFailure(state, 'github');
    updateHealthCheck(state, 'github');
    expect(probeCircuitBreaker(state, 'github')).toBe(false);
  });

  it('probeCircuitBreaker returns false when not open', () => {
    expect(probeCircuitBreaker(state, 'github')).toBe(false);
  });
});

describe('disk queue', () => {
  beforeEach(() => {
    if (existsSync(QUEUE_DIR)) rmSync(QUEUE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(QUEUE_DIR)) rmSync(QUEUE_DIR, { recursive: true });
  });

  it('enqueues and lists entries', async () => {
    await enqueueOutcome(makePayload({ action_name: 'test_tool' }));
    const entries = await listQueuedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].payload.action_name).toBe('test_tool');
  });

  it('dequeues entries', async () => {
    await enqueueOutcome(makePayload());
    const entries = await listQueuedEntries();
    await dequeueEntry(entries[0].id);
    const remaining = await listQueuedEntries();
    expect(remaining).toHaveLength(0);
  });

  it('processQueue sends and removes entries', async () => {
    const sender = vi.fn().mockResolvedValue(true);
    await enqueueOutcome(makePayload());
    await enqueueOutcome(makePayload());
    const sent = await processQueue(sender);
    expect(sent).toBe(2);
    const remaining = await listQueuedEntries();
    expect(remaining).toHaveLength(0);
  });

  it('processQueue expires old entries', async () => {
    const sender = vi.fn().mockResolvedValue(false);
    await enqueueOutcome(makePayload());
    const entries = await listQueuedEntries();
    // Manually set firstAttempt to expired
    const { updateQueuedEntry } = await import('../src/fail-open.js');
    await updateQueuedEntry({ ...entries[0], firstAttempt: Date.now() - 400_000 });
    const sent = await processQueue(sender);
    expect(sent).toBe(0);
    const remaining = await listQueuedEntries();
    expect(remaining).toHaveLength(0); // Expired
  });
});

describe('backoffDelay', () => {
  it('calculates exponential backoff', () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(3)).toBe(8000);
  });

  it('caps at max retry time', () => {
    expect(backoffDelay(20)).toBeLessThanOrEqual(300_000);
  });
});

describe('getQueueStats', () => {
  beforeEach(() => {
    if (existsSync(QUEUE_DIR)) rmSync(QUEUE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(QUEUE_DIR)) rmSync(QUEUE_DIR, { recursive: true });
  });

  it('returns empty stats when no entries', async () => {
    const stats = await getQueueStats();
    expect(stats.count).toBe(0);
    expect(stats.oldestMs).toBeNull();
  });

  it('returns count and age', async () => {
    await enqueueOutcome(makePayload());
    const stats = await getQueueStats();
    expect(stats.count).toBe(1);
    expect(stats.oldestMs).not.toBeNull();
  });
});

describe('startQueueProcessor', () => {
  beforeEach(() => {
    if (existsSync(QUEUE_DIR)) rmSync(QUEUE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(QUEUE_DIR)) rmSync(QUEUE_DIR, { recursive: true });
  });

  it('returns a stop function', () => {
    const sender = vi.fn().mockResolvedValue(true);
    const proc = startQueueProcessor(sender, 60_000);
    expect(proc.stop).toBeDefined();
    proc.stop();
  });

  it('drains queue on startup', async () => {
    const sender = vi.fn().mockResolvedValue(true);
    await enqueueOutcome(makePayload());
    const proc = startQueueProcessor(sender, 60_000);
    // Small wait for async drain
    await new Promise((r) => setTimeout(r, 100));
    proc.stop();
    // Should have attempted to send
    expect(sender).toHaveBeenCalled();
  });
});
