/**
 * MSW v2 setup for mocking fetch in tests.
 */
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { beforeAll, afterAll, afterEach } from 'vitest';

export const VALID_KEY = 'layer5_testkey12345678901234';
export const BASE_URL = 'https://api.layer5.dev';

export const MOCK_SCORES = {
  ranked_actions: [
    {
      action_name: 'update_app',
      score: 0.85,
      confidence: 0.90,
      trend: 'improving',
      rank: 1,
      recommendation: 'use',
    },
    {
      action_name: 'restart_service',
      score: 0.07,
      confidence: 0.80,
      trend: 'degrading',
      rank: 2,
      recommendation: 'avoid',
    },
  ],
  policy: {
    decision: 'exploit',
    reason: 'high_confidence_score',
    top_action: 'update_app',
    explore_action: null,
  },
  context_warning: null,
  agent_trust: { status: 'trusted', score: 0.85 },
};

export const MOCK_OUTCOME = {
  outcome_id: 'test-uuid-123',
  success: true,
  action_id: 'act-456',
  context_id: 'ctx-789',
  timestamp: '2025-01-01T00:00:00Z',
  message: 'Outcome logged',
  new_score: 0.87,
  recommendation: null,
  next_actions: null,
  policy: {
    decision: 'exploit',
    reason: 'score_improved',
    top_action: 'update_app',
    explore_action: null,
  },
  agent_trust: { status: 'trusted', score: 0.87 },
};

export const MOCK_FEEDBACK = {
  updated: true,
  outcome_id: 'test-uuid-123',
  final_score: 0.3,
  business_outcome: 'partial',
};

export const server = setupServer(
  http.get(`${BASE_URL}/v1/get-scores`, () =>
    HttpResponse.json(MOCK_SCORES)
  ),
  http.post(`${BASE_URL}/v1/log-outcome`, () =>
    HttpResponse.json(MOCK_OUTCOME, { status: 201 })
  ),
  http.post(`${BASE_URL}/v1/outcome-feedback`, () =>
    HttpResponse.json(MOCK_FEEDBACK)
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
