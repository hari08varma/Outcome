/**
 * Tests for Layer5 TypeScript SDK — retry logic.
 *
 * Mirrors the Python SDK test_retry.py test cases.
 */

import { describe, expect, it } from 'vitest';
import { exponentialBackoff, sleep } from '../src/retry.js';

describe('exponentialBackoff', () => {
  it('returns base delay for attempt 0 (no jitter)', () => {
    expect(exponentialBackoff(0, 500, 30_000, false)).toBe(500);
  });

  it('doubles delay for each attempt (no jitter)', () => {
    expect(exponentialBackoff(0, 500, 30_000, false)).toBe(500);
    expect(exponentialBackoff(1, 500, 30_000, false)).toBe(1000);
    expect(exponentialBackoff(2, 500, 30_000, false)).toBe(2000);
    expect(exponentialBackoff(3, 500, 30_000, false)).toBe(4000);
  });

  it('caps at maxDelay (no jitter)', () => {
    expect(exponentialBackoff(10, 500, 30_000, false)).toBe(30_000);
    expect(exponentialBackoff(20, 500, 30_000, false)).toBe(30_000);
  });

  it('adds jitter within ±25% range', () => {
    const results: number[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(exponentialBackoff(0, 1000, 30_000, true));
    }
    // With jitter on base=1000: range is 750–1250
    const min = Math.min(...results);
    const max = Math.max(...results);
    expect(min).toBeGreaterThanOrEqual(750);
    expect(max).toBeLessThanOrEqual(1250);
    // Should have some variance (not all identical)
    expect(max - min).toBeGreaterThan(0);
  });

  it('uses default parameters', () => {
    const delay = exponentialBackoff(0);
    // Default: base=500, jitter=true → 375–625
    expect(delay).toBeGreaterThanOrEqual(375);
    expect(delay).toBeLessThanOrEqual(625);
  });

  it('caps jittered values at maxDelay range', () => {
    // At attempt 20, base delay is way over max, so capped
    const delay = exponentialBackoff(20, 500, 1000, true);
    // maxDelay=1000, with jitter: 750–1250
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1250);
  });
});

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Should be at least 40ms (allowing timer imprecision)
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('resolves with zero delay', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
