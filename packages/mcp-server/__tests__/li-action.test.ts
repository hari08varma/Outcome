/**
 * Integration tests for li-action.ts — Decision Layer Gateway
 *
 * Uses a mock RestClient to test all decision paths:
 *   - Pass-through on cold start
 *   - Pass-through on insufficient data
 *   - Assist mode: warn when better action exists
 *   - Assist mode: pass-through when gap too small
 *   - Auto mode: redirect to best action (Path B)
 *   - Auto mode: downgrade to assist on low confidence
 *   - Auto mode: pass-through on no_data
 *   - Loop prevention via EpisodeTracker
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createLiActionHandler } from '../src/tools/li-action.js';
import { EpisodeTracker } from '../src/episode-tracker.js';
import type { LIConfig } from '../src/config.js';
import type { LIResult } from '../src/rest-client.js';

// ── Mock RestClient ─────────────────────────────────────────
function createMockClient(options: {
  scores?: Record<string, unknown>;
  scoresError?: boolean;
  recommendations?: Record<string, unknown>;
  recsError?: boolean;
  adminActions?: unknown[];
}) {
  return {
    get: async <T>(path: string): Promise<LIResult<T>> => {
      if (path.startsWith('/v1/get-scores')) {
        if (options.scoresError) {
          return { ok: false, status: 503, error: { error: 'unavailable', code: 'SERVICE_UNAVAILABLE' } } as LIResult<T>;
        }
        return { ok: true, status: 200, data: options.scores as T } as LIResult<T>;
      }
      if (path.startsWith('/v1/recommendations')) {
        if (options.recsError) {
          return { ok: false, status: 503, error: { error: 'unavailable', code: 'SERVICE_UNAVAILABLE' } } as LIResult<T>;
        }
        return { ok: true, status: 200, data: options.recommendations as T } as LIResult<T>;
      }
      if (path.startsWith('/v1/admin')) {
        return { ok: true, status: 200, data: { actions: options.adminActions ?? [] } as T } as LIResult<T>;
      }
      return { ok: false, status: 404, error: { error: 'Not found', code: 'NOT_FOUND' } } as LIResult<T>;
    },
    post: async <T>(): Promise<LIResult<T>> => {
      return { ok: true, status: 200, data: {} as T } as LIResult<T>;
    },
    put: async <T>(): Promise<LIResult<T>> => {
      return { ok: true, status: 200, data: {} as T } as LIResult<T>;
    },
  };
}

function makeConfig(mode: 'assist' | 'auto'): LIConfig {
  return Object.freeze({
    apiKey: 'test-key',
    baseUrl: 'https://test.layerinfinite.me',
    mode,
    adminKey: null,
  });
}

function parseResponse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

// ── Reusable score fixtures ─────────────────────────────────
const stableScores = {
  ranked_actions: [
    { action_name: 'switch_provider', composite_score: 0.85, confidence: 0.92 },
    { action_name: 'retry_payment', composite_score: 0.60, confidence: 0.88 },
    { action_name: 'escalate_to_human', composite_score: 0.40, confidence: 0.95 },
  ],
  decision_id: 'dec-test-123',
  cold_start: false,
  outcomes_needed: 0,
};

const coldStartScores = {
  ranked_actions: [],
  decision_id: 'dec-cold',
  cold_start: true,
  outcomes_needed: 50,
};

const earlyScores = {
  ...stableScores,
  outcomes_needed: 20, // not enough data
};

const stableRecs = {
  state: 'stable',
  best_action: 'switch_provider',
  confidence: 0.92,
};

const earlyRecs = {
  state: 'early_signal',
  best_action: 'switch_provider',
  confidence: 0.65,
};

const noDataRecs = {
  state: 'no_data',
};

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('li_action — Assist Mode', () => {
  let tracker: EpisodeTracker;

  beforeEach(() => {
    tracker = new EpisodeTracker();
  });

  it('passes through on cold start', async () => {
    const client = createMockClient({ scores: coldStartScores, recommendations: noDataRecs });
    const handler = createLiActionHandler(client as any, makeConfig('assist'), tracker);

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    expect(data.approved).toBe(true);
    expect(data.action).toBe('retry_payment');
    expect(data.reason).toContain('Insufficient data');
  });

  it('passes through when outcomes_needed > 0', async () => {
    const client = createMockClient({ scores: earlyScores, recommendations: earlyRecs });
    const handler = createLiActionHandler(client as any, makeConfig('assist'), tracker);

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    expect(data.approved).toBe(true);
    expect(data.reason).toContain('Insufficient data');
  });

  it('passes through when agent choice is already top-ranked', async () => {
    const client = createMockClient({ scores: stableScores, recommendations: stableRecs });
    const handler = createLiActionHandler(client as any, makeConfig('assist'), tracker);

    const result = await handler({
      action_name: 'switch_provider',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    expect(data.approved).toBe(true);
    expect(data.action).toBe('switch_provider');
  });

  it('warns when better action exists with sufficient gap', async () => {
    const client = createMockClient({ scores: stableScores, recommendations: stableRecs });
    const handler = createLiActionHandler(client as any, makeConfig('assist'), tracker);

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    expect(data.approved).toBe(false);
    expect(data.mode).toBe('assist');
    expect(data.suggested_action).toBeDefined();
    expect((data.suggested_action as any).name).toBe('switch_provider');
  });

  it('passes through when scores API fails', async () => {
    const client = createMockClient({ scoresError: true, recommendations: stableRecs });
    const handler = createLiActionHandler(client as any, makeConfig('assist'), tracker);

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    expect(data.approved).toBe(true);
    expect(data.reason).toContain('Scores API unavailable');
  });
});

describe('li_action — Auto Mode', () => {
  let tracker: EpisodeTracker;

  beforeEach(() => {
    tracker = new EpisodeTracker();
  });

  it('redirects to best action with stable + high confidence', async () => {
    const client = createMockClient({ scores: stableScores, recommendations: stableRecs });
    const handler = createLiActionHandler(client as any, makeConfig('auto'), tracker);

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    expect(data.mode).toBe('auto');
    expect(data.action).toBe('switch_provider');
    expect(data.redirected_from).toBe('retry_payment');
    expect(data.decision_id).toBe('dec-test-123');
  });

  it('downgrades to assist on early_signal', async () => {
    const client = createMockClient({ scores: stableScores, recommendations: earlyRecs });
    const handler = createLiActionHandler(client as any, makeConfig('auto'), tracker);

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    // Should downgrade to assist mode since recs.state != 'stable'
    // and then either warn (if gap big enough) or pass through
    expect(data.mode === 'assist' || data.approved === true).toBe(true);
  });

  it('passes through on no_data recommendations', async () => {
    const client = createMockClient({ scores: stableScores, recommendations: noDataRecs });
    const handler = createLiActionHandler(client as any, makeConfig('auto'), tracker);

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
    });

    const data = parseResponse(result);
    expect(data.approved).toBe(true);
    expect(data.reason).toContain('pass-through');
  });

  // ── Loop prevention ─────────────────────────────────────
  it('skips already-tried actions in redirect', async () => {
    const client = createMockClient({ scores: stableScores, recommendations: stableRecs });
    const handler = createLiActionHandler(client as any, makeConfig('auto'), tracker);

    // Pre-mark switch_provider as tried
    tracker.markTried('ep-loop', 'switch_provider');

    const result = await handler({
      action_name: 'retry_payment',
      task: 'payment_failed',
      episode_id: 'ep-loop',
    });

    const data = parseResponse(result);
    // switch_provider is tried, so next best is escalate_to_human
    if (data.action !== 'retry_payment') {
      expect(data.action).toBe('escalate_to_human');
    }
  });
});
