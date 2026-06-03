import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { generateDecisionId, DecisionTracker } from '../src/decision-tracker.js';
import type { LiApiClient } from '../src/rest-client.js';
import type { DecisionRecord } from '../src/types.js';

function mockLiApi(): LiApiClient {
  return {
    logOutcome: vi.fn().mockResolvedValue(true),
  } as unknown as LiApiClient;
}

function makeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decisionId: 'dec_test123_agnt_abcd',
    agentId: 'agent-1',
    customerId: 'cust-1',
    taskType: 'build_failed',
    actionName: 'github_push',
    upstreamName: 'github',
    originalAction: 'github_push',
    executedAction: 'github_push',
    mode: 'recommend',
    rerouted: false,
    enrichmentScores: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('generateDecisionId', () => {
  it('produces dec_ prefix', () => {
    const id = generateDecisionId('agent-1');
    expect(id.startsWith('dec_')).toBe(true);
  });

  it('contains agent hash segment', () => {
    const id = generateDecisionId('agent-1');
    const parts = id.split('_');
    expect(parts).toHaveLength(4); // dec, ts12, agent4, rand4
    expect(parts[1].length).toBe(12);
    expect(parts[2].length).toBe(4);
    expect(parts[3].length).toBe(4);
  });

  it('produces different IDs for different agents', () => {
    const id1 = generateDecisionId('agent-1');
    const id2 = generateDecisionId('agent-2');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for same agent on subsequent calls', () => {
    const id1 = generateDecisionId('agent-1');
    const id2 = generateDecisionId('agent-1');
    expect(id1).not.toBe(id2); // Different timestamps or random
  });

  it('uses only base62 characters', () => {
    const id = generateDecisionId('agent-test');
    expect(id).toMatch(/^dec_[0-9A-Za-z]+_[0-9A-Za-z]+_[0-9A-Za-z]+$/);
  });
});

describe('DecisionTracker', () => {
  let tracker: DecisionTracker;
  let liApi: LiApiClient;

  beforeEach(() => {
    liApi = mockLiApi();
    tracker = new DecisionTracker(liApi, 'production');
  });

  afterEach(() => {
    tracker.stopFlushTimer();
  });

  describe('episodes', () => {
    it('creates episode with unique ID', () => {
      const ep1 = tracker.startEpisode('agent-1', 'cust-1');
      const ep2 = tracker.startEpisode('agent-1', 'cust-1');
      expect(ep1.episodeId).not.toBe(ep2.episodeId);
    });

    it('sets agent and session start', () => {
      const ep = tracker.startEpisode('agent-1', 'cust-1');
      expect(ep.agentId).toBe('agent-1');
      expect(ep.coachingCount).toBe(0);
      expect(ep.decisions).toEqual([]);
    });

    it('retrieves episode by ID', () => {
      const ep = tracker.startEpisode('agent-1', 'cust-1');
      const found = tracker.getEpisode(ep.episodeId);
      expect(found).toBeDefined();
      expect(found!.episodeId).toBe(ep.episodeId);
    });
  });

  describe('coaching', () => {
    it('allows up to 3 coachings per episode', () => {
      const ep = tracker.startEpisode('agent-1', 'cust-1');
      expect(tracker.recordCoaching(ep.episodeId)).toBe(true);
      expect(tracker.recordCoaching(ep.episodeId)).toBe(true);
      expect(tracker.recordCoaching(ep.episodeId)).toBe(true);
      expect(tracker.recordCoaching(ep.episodeId)).toBe(false);
    });

    it('canCoach returns true when under limit', () => {
      const ep = tracker.startEpisode('agent-1', 'cust-1');
      expect(tracker.canCoach(ep.episodeId)).toBe(true);
      tracker.recordCoaching(ep.episodeId);
      tracker.recordCoaching(ep.episodeId);
      tracker.recordCoaching(ep.episodeId);
      expect(tracker.canCoach(ep.episodeId)).toBe(false);
    });

    it('canCoach returns true for unknown episode', () => {
      expect(tracker.canCoach('nonexistent')).toBe(true);
    });
  });

  describe('decisions', () => {
    it('buffers decisions', () => {
      tracker.recordDecision(makeRecord());
      tracker.recordDecision(makeRecord());
      expect(tracker.bufferSize).toBe(2);
    });

    it('links decisions to episodes', () => {
      const ep = tracker.startEpisode('agent-1', 'cust-1');
      tracker.recordDecision(makeRecord({ agentId: 'agent-1' }));
      const found = tracker.getEpisode(ep.episodeId);
      expect(found!.decisions).toHaveLength(1);
    });
  });

  describe('flush', () => {
    it('flushes buffered decisions to LI API', async () => {
      tracker.recordDecision(makeRecord());
      tracker.recordDecision(makeRecord());
      await tracker.flushBuffer();
      expect(liApi.logOutcome).toHaveBeenCalledTimes(2);
      expect(tracker.bufferSize).toBe(0);
    });

    it('re-queues on API failure', async () => {
      (liApi.logOutcome as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      tracker.recordDecision(makeRecord());
      await tracker.flushBuffer();
      expect(tracker.bufferSize).toBe(1);
    });

    it('does nothing when buffer is empty', async () => {
      await tracker.flushBuffer();
      expect(liApi.logOutcome).not.toHaveBeenCalled();
    });

    it('prevents concurrent flushes', async () => {
      tracker.recordDecision(makeRecord());
      // Start a flush but don't await it
      const flush1 = tracker.flushBuffer();
      const flush2 = tracker.flushBuffer();
      await Promise.all([flush1, flush2]);
      // Should only call API once since second flush sees flushing=true
      expect(liApi.logOutcome).toHaveBeenCalledTimes(1);
    });
  });

  describe('timer', () => {
    it('starts and stops flush timer', () => {
      vi.useFakeTimers();
      tracker = new DecisionTracker(liApi, 'production');
      tracker.startFlushTimer();
      tracker.recordDecision(makeRecord());

      vi.advanceTimersByTime(5000);
      expect(liApi.logOutcome).toHaveBeenCalled();

      tracker.stopFlushTimer();
      vi.useRealTimers();
    });

    it('does not double-start timer', () => {
      tracker.startFlushTimer();
      tracker.startFlushTimer();
      tracker.stopFlushTimer();
      // Should not throw
    });
  });
});
