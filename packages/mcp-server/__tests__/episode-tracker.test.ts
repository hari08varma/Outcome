/**
 * Tests for episode-tracker.ts — Redirect Loop Prevention
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EpisodeTracker } from '../src/episode-tracker.js';

describe('EpisodeTracker', () => {
  let tracker: EpisodeTracker;

  beforeEach(() => {
    tracker = new EpisodeTracker();
  });

  // ── Basic marking + checking ──────────────────────────────
  it('marks an action as tried and retrieves it', () => {
    tracker.markTried('ep-1', 'retry_payment');
    expect(tracker.hasTried('ep-1', 'retry_payment')).toBe(true);
    expect(tracker.hasTried('ep-1', 'switch_provider')).toBe(false);
  });

  it('tracks multiple actions per episode', () => {
    tracker.markTried('ep-1', 'retry_payment');
    tracker.markTried('ep-1', 'switch_provider');
    tracker.markTried('ep-1', 'escalate_to_human');

    const tried = tracker.getTriedActions('ep-1');
    expect(tried.size).toBe(3);
    expect(tried.has('retry_payment')).toBe(true);
    expect(tried.has('switch_provider')).toBe(true);
    expect(tried.has('escalate_to_human')).toBe(true);
  });

  // ── Episode isolation ─────────────────────────────────────
  it('isolates episodes from each other', () => {
    tracker.markTried('ep-1', 'retry_payment');
    tracker.markTried('ep-2', 'switch_provider');

    expect(tracker.hasTried('ep-1', 'retry_payment')).toBe(true);
    expect(tracker.hasTried('ep-1', 'switch_provider')).toBe(false);
    expect(tracker.hasTried('ep-2', 'switch_provider')).toBe(true);
    expect(tracker.hasTried('ep-2', 'retry_payment')).toBe(false);
  });

  // ── Unknown episode returns empty set ─────────────────────
  it('returns empty set for unknown episode', () => {
    const tried = tracker.getTriedActions('nonexistent');
    expect(tried.size).toBe(0);
    expect(tracker.hasTried('nonexistent', 'any_action')).toBe(false);
  });

  // ── Duplicate marking is idempotent ───────────────────────
  it('duplicate markTried calls are idempotent', () => {
    tracker.markTried('ep-1', 'retry_payment');
    tracker.markTried('ep-1', 'retry_payment');
    tracker.markTried('ep-1', 'retry_payment');

    expect(tracker.getTriedActions('ep-1').size).toBe(1);
  });

  // ── Expiry ────────────────────────────────────────────────
  it('expires entries after 30 minutes', () => {
    vi.useFakeTimers();

    try {
      tracker.markTried('ep-old', 'action_a');
      expect(tracker.hasTried('ep-old', 'action_a')).toBe(true);

      // Advance 31 minutes
      vi.advanceTimersByTime(31 * 60 * 1000);

      // The next call triggers cleanup
      expect(tracker.hasTried('ep-old', 'action_a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expire entries within 30 minutes', () => {
    vi.useFakeTimers();

    try {
      tracker.markTried('ep-recent', 'action_b');

      // Advance 29 minutes
      vi.advanceTimersByTime(29 * 60 * 1000);

      expect(tracker.hasTried('ep-recent', 'action_b')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
