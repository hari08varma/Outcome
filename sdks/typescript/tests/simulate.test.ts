/**
 * Tests for simulate(), decision_id threading, and new response fields.
 * Mirrors the Python SDK test_simulate.py test cases.
 */

import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Layer5 } from '../src/client.js';
import { Layer5ValidationError } from '../src/errors.js';
import { server, VALID_KEY, BASE_URL } from './setup.js';
import type { SimulateResponse, GetScoresResponse, LogOutcomeResponse } from '../src/types.js';

// ── Mock data ────────────────────────────────────────────────

const MOCK_SIMULATE: SimulateResponse = {
  primary: {
    actions: ['clear_cache', 'update_app'],
    predicted_outcome: 0.83,
    outcome_interval_low: 0.71,
    outcome_interval_high: 0.92,
    confidence: 0.85,
    predicted_resolution: 0.80,
    predicted_steps: 2.0,
    better_than_proposed: false,
  },
  alternatives: [
    {
      actions: ['restart_service'],
      predicted_outcome: 0.90,
      outcome_interval_low: 0.80,
      outcome_interval_high: 0.95,
      confidence: 0.88,
      predicted_resolution: 0.85,
      predicted_steps: 1.0,
      better_than_proposed: true,
    },
  ],
  simulation_tier: 2,
  tier_explanation: 'LightGBM model used (tier 2)',
  data_source: 'world_model_v3',
  episode_count: 500,
  simulation_warning: null,
};

const MOCK_SCORES_WITH_DECISION: GetScoresResponse = {
  ranked_actions: [
    {
      action_name: 'update_app',
      score: 0.85,
      confidence: 0.90,
      trend: 'improving',
      rank: 1,
      recommendation: 'use',
    },
  ],
  top_action: 'update_app',
  should_escalate: false,
  cold_start: false,
  context_id: 'ctx-1',
  customer_id: 'cust-1',
  issue_type: 'payment_failed',
  context_match: null,
  context_warning: null,
  view_refreshed_at: null,
  served_from_cache: null,
  policy: 'exploit',
  policy_reason: 'high_confidence',
  agent_trust: { score: 0.85, status: 'trusted' },
  meta: null,
  decisionId: 'dec-abc-123',
};

const MOCK_OUTCOME_WITH_COUNTERFACTUALS: LogOutcomeResponse = {
  success: true,
  outcome_id: 'out-789',
  action_id: 'act-456',
  context_id: 'ctx-1',
  timestamp: '2026-03-11T00:00:00Z',
  message: 'Outcome logged',
  recommendation: null,
  next_actions: null,
  counterfactuals_computed: true,
  sequence_position: 2,
};

// ── Helpers ──────────────────────────────────────────────────

function makeClient(overrides: Record<string, unknown> = {}) {
  return new Layer5({
    apiKey: VALID_KEY,
    baseUrl: BASE_URL,
    agentId: 'test-agent',
    ...overrides,
  });
}

// ── simulate: validation ────────────────────────────────────

describe('simulate validation', () => {
  it('empty sequence → Layer5ValidationError', () => {
    const client = makeClient();
    expect(
      client.simulate({
        proposedSequence: [],
        context: { issue_type: 'payment_failed' },
      })
    ).rejects.toThrow(Layer5ValidationError);
  });

  it('sequence > 5 → Layer5ValidationError', () => {
    const client = makeClient();
    expect(
      client.simulate({
        proposedSequence: ['a', 'b', 'c', 'd', 'e', 'f'],
        context: { issue_type: 'test' },
      })
    ).rejects.toThrow(Layer5ValidationError);
  });
});

// ── simulate: success ───────────────────────────────────────

describe('simulate response', () => {
  it('valid request → SimulateResponse', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/simulate`, () =>
        HttpResponse.json(MOCK_SIMULATE)
      )
    );
    const client = makeClient();
    const result = await client.simulate({
      proposedSequence: ['clear_cache', 'update_app'],
      context: { issue_type: 'payment_failed' },
    });
    expect(result.primary).toBeDefined();
    expect(result.alternatives).toBeInstanceOf(Array);
  });

  it('simulation_tier is 1, 2, or 3', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/simulate`, () =>
        HttpResponse.json(MOCK_SIMULATE)
      )
    );
    const client = makeClient();
    const result = await client.simulate({
      proposedSequence: ['clear_cache'],
      context: { issue_type: 'test' },
    });
    expect([1, 2, 3]).toContain(result.simulation_tier);
  });

  it('primary.predicted_outcome in [0, 1]', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/simulate`, () =>
        HttpResponse.json(MOCK_SIMULATE)
      )
    );
    const client = makeClient();
    const result = await client.simulate({
      proposedSequence: ['clear_cache'],
      context: { issue_type: 'test' },
    });
    expect(result.primary.predicted_outcome).toBeGreaterThanOrEqual(0);
    expect(result.primary.predicted_outcome).toBeLessThanOrEqual(1);
  });

  it('primary.outcome_interval_low <= predicted_outcome', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/simulate`, () =>
        HttpResponse.json(MOCK_SIMULATE)
      )
    );
    const client = makeClient();
    const result = await client.simulate({
      proposedSequence: ['clear_cache'],
      context: { issue_type: 'test' },
    });
    expect(result.primary.outcome_interval_low).toBeLessThanOrEqual(
      result.primary.predicted_outcome
    );
  });

  it('alternatives returned when requested', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/simulate`, () =>
        HttpResponse.json(MOCK_SIMULATE)
      )
    );
    const client = makeClient();
    const result = await client.simulate({
      proposedSequence: ['clear_cache'],
      context: { issue_type: 'test' },
      simulateAlternatives: 2,
    });
    expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(result.alternatives[0]!.better_than_proposed).toBe(true);
  });

  it('simulation_warning null or string', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/simulate`, () =>
        HttpResponse.json(MOCK_SIMULATE)
      )
    );
    const client = makeClient();
    const result = await client.simulate({
      proposedSequence: ['clear_cache'],
      context: { issue_type: 'test' },
    });
    expect(
      result.simulation_warning === null ||
        typeof result.simulation_warning === 'string'
    ).toBe(true);
  });
});

// ── get_scores: decision_id ─────────────────────────────────

describe('get_scores decision_id', () => {
  it('decisionId in response', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json(MOCK_SCORES_WITH_DECISION)
      )
    );
    const client = makeClient();
    const result = await client.getScores({
      context: { issue_type: 'payment_failed' },
    });
    expect(result.decisionId).toBe('dec-abc-123');
  });

  it('episodeHistory passed when provided', async () => {
    let receivedParams: URLSearchParams | undefined;
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        receivedParams = new URL(request.url).searchParams;
        return HttpResponse.json(MOCK_SCORES_WITH_DECISION);
      })
    );
    const client = makeClient();
    await client.getScores({
      context: { issue_type: 'test' },
      episodeHistory: ['action_a', 'action_b'],
    });
    expect(receivedParams?.has('episode_history')).toBe(true);
  });
});

// ── log_outcome: decision_id ────────────────────────────────

describe('log_outcome decision_id', () => {
  it('decisionId passed when provided', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME_WITH_COUNTERFACTUALS, {
          status: 201,
        });
      })
    );
    const client = makeClient();
    await client.logOutcome({
      actionName: 'update_app',
      success: true,
      decisionId: 'dec-abc-123',
    });
    expect(receivedBody?.decision_id).toBe('dec-abc-123');
  });

  it('counterfactuals_computed in response', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/log-outcome`, () =>
        HttpResponse.json(MOCK_OUTCOME_WITH_COUNTERFACTUALS, { status: 201 })
      )
    );
    const client = makeClient();
    const result = await client.logOutcome({
      actionName: 'update_app',
      success: true,
    });
    expect(result.counterfactuals_computed).toBe(true);
    expect(result.sequence_position).toBe(2);
  });
});

// ── langchain: decision_id threading ────────────────────────

describe('langchain decision_id threading', () => {
  it('decisionId threaded from getScores to logOutcome', async () => {
    // Use mock handlers that return decisionId
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json(MOCK_SCORES_WITH_DECISION)
      ),
      http.post(`${BASE_URL}/v1/log-outcome`, () =>
        HttpResponse.json(MOCK_OUTCOME_WITH_COUNTERFACTUALS, { status: 201 })
      )
    );

    const { Layer5Callback } = await import(
      '../src/integrations/langchain.js'
    );

    const callback = new Layer5Callback({
      apiKey: VALID_KEY,
      agentId: 'test-agent',
      baseUrl: BASE_URL,
      silentErrors: false,
    });

    // Spy on logOutcome to check decisionId is passed
    let capturedDecisionId: string | undefined;
    const origLogOutcome = (callback as unknown as { client: Layer5 }).client.logOutcome.bind(
      (callback as unknown as { client: Layer5 }).client
    );
    (callback as unknown as { client: Layer5 }).client.logOutcome = async (opts) => {
      capturedDecisionId = opts.decisionId;
      return origLogOutcome(opts);
    };

    await callback.handleToolStart(
      { name: 'my_tool' },
      '{}',
      'run-1'
    );

    await callback.handleToolEnd('done', 'run-1');

    expect(capturedDecisionId).toBe('dec-abc-123');
  });
});
