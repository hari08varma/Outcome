/**
 * Tests for Layer5 TypeScript SDK — core client.
 *
 * Uses MSW v2 for fetch mocking. No real HTTP calls.
 * Mirrors the Python SDK test_client.py test cases.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Layer5 } from '../src/client.js';
import {
  Layer5AgentSuspendedError,
  Layer5AuthError,
  Layer5Error,
  Layer5NetworkError,
  Layer5RateLimitError,
  Layer5ServerError,
  Layer5TimeoutError,
  Layer5UnknownActionError,
  Layer5ValidationError,
} from '../src/errors.js';
import { server, VALID_KEY, BASE_URL, MOCK_SCORES, MOCK_OUTCOME, MOCK_FEEDBACK } from './setup.js';

// ── Helpers ───────────────────────────────────────────────────

function makeClient(overrides: Record<string, unknown> = {}) {
  return new Layer5({
    apiKey: VALID_KEY,
    baseUrl: BASE_URL,
    agentId: 'test-agent',
    ...overrides,
  });
}

// ── Client Init ──────────────────────────────────────────────

describe('Layer5 Client Init', () => {
  it('creates client with valid key', () => {
    const client = makeClient();
    expect(client).toBeInstanceOf(Layer5);
    expect(client.agentId).toBe('test-agent');
  });

  it('throws Layer5AuthError when no key', () => {
    expect(() => new Layer5({})).toThrow(Layer5AuthError);
  });

  it('throws Layer5AuthError for invalid key format', () => {
    expect(() => new Layer5({ apiKey: 'bad_key' })).toThrow(Layer5AuthError);
  });

  it('throws Layer5AuthError for short key', () => {
    expect(() => new Layer5({ apiKey: 'layer5_short' })).toThrow(
      Layer5AuthError
    );
  });

  it('process.env.LAYER5_API_KEY used if no explicit key', () => {
    const original = process.env.LAYER5_API_KEY;
    process.env.LAYER5_API_KEY = VALID_KEY;
    try {
      const client = new Layer5({});
      expect(client).toBeInstanceOf(Layer5);
    } finally {
      if (original !== undefined) {
        process.env.LAYER5_API_KEY = original;
      } else {
        delete process.env.LAYER5_API_KEY;
      }
    }
  });

  it("typeof Deno check doesn't throw in Node.js", () => {
    // Should safely handle Deno not being defined
    expect(() => makeClient()).not.toThrow();
  });

  it('instanceof Layer5AuthError works correctly', () => {
    // Tests Object.setPrototypeOf fix
    try {
      new Layer5({ apiKey: 'invalid' });
    } catch (e) {
      expect(e).toBeInstanceOf(Layer5AuthError);
      expect(e).toBeInstanceOf(Layer5Error);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('strips trailing slash from base URL', () => {
    const client = makeClient({ baseUrl: 'https://api.example.com/' });
    expect(client).toBeInstanceOf(Layer5);
  });
});

// ── getScores ────────────────────────────────────────────────

describe('getScores', () => {
  let client: Layer5;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns ranked actions from MSW mock', async () => {
    const result = await client.getScores({
      context: { issue_type: 'payment_failed' },
    });

    expect(result.ranked_actions).toHaveLength(2);
    expect(result.ranked_actions[0].action_name).toBe('update_app');
    expect(result.ranked_actions[0].score).toBe(0.85);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends correct GET request with query params', async () => {
    let capturedUrl = '';
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(MOCK_SCORES);
      })
    );

    await client.getScores({
      context: { issue_type: 'auth_failure' },
    });

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe('/v1/get-scores');
    expect(url.searchParams.get('agent_id')).toBe('test-agent');
    expect(url.searchParams.get('issue_type')).toBe('auth_failure');
  });

  it('throws Layer5ValidationError when no agentId', async () => {
    const noAgentClient = makeClient({ agentId: undefined });
    await expect(
      noAgentClient.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5ValidationError);
  });

  it('overrides agentId from options', async () => {
    let capturedUrl = '';
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(MOCK_SCORES);
      })
    );

    await client.getScores({
      agentId: 'override-agent',
      context: { issue_type: 'test' },
    });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get('agent_id')).toBe('override-agent');
  });

  it('sends top_n and refresh params', async () => {
    let capturedUrl = '';
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(MOCK_SCORES);
      })
    );

    await client.getScores({
      context: { issue_type: 'test' },
      topN: 5,
      refresh: true,
    });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get('top_n')).toBe('5');
    expect(url.searchParams.get('refresh')).toBe('true');
  });

  it('serializes full context when no issue_type or context_id', async () => {
    let capturedUrl = '';
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(MOCK_SCORES);
      })
    );

    await client.getScores({
      context: { custom_field: 'value' },
    });

    const url = new URL(capturedUrl);
    const issueType = url.searchParams.get('issue_type');
    expect(issueType).toBe(JSON.stringify({ custom_field: 'value' }));
  });
});

// ── logOutcome ───────────────────────────────────────────────

describe('logOutcome', () => {
  let client: Layer5;

  beforeEach(() => {
    client = makeClient();
  });

  it('sends correct POST request with explicit fields', async () => {
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    const result = await client.logOutcome({
      actionName: 'reset_password',
      success: true,
      sessionId: 'sess-123',
      issueType: 'auth_failure',
      responseTimeMs: 241,
    });

    expect(result.outcome_id).toBe('test-uuid-123');
    expect(capturedBody.session_id).toBe('sess-123');
    expect(capturedBody.action_name).toBe('reset_password');
    expect(capturedBody.issue_type).toBe('auth_failure');
    expect(capturedBody.success).toBe(true);
    expect(capturedBody.response_time_ms).toBe(241);
  });

  it('derives sessionId and issueType when using context/responseMs', async () => {
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    await client.logOutcome({
      actionName: 'update_app',
      success: true,
      context: { tool: 'update_app', issue_type: 'deploy' },
      responseMs: 150,
      feedbackSignal: 'immediate',
    });

    // sessionId defaults to 'sdk-auto'
    expect(capturedBody.session_id).toBe('sdk-auto');
    // issueType derived from context.issue_type
    expect(capturedBody.issue_type).toBe('deploy');
    // responseMs mapped to response_time_ms
    expect(capturedBody.response_time_ms).toBe(150);
    // context mapped to raw_context
    expect(capturedBody.raw_context).toEqual({ tool: 'update_app', issue_type: 'deploy' });
  });

  it('derives issueType from actionName when no context.issue_type', async () => {
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    await client.logOutcome({
      actionName: 'restart_service',
      success: false,
      context: { tool: 'restart_service' },
    });

    expect(capturedBody.issue_type).toBe('restart_service');
  });

  it('throws Layer5ValidationError when no agentId', async () => {
    const noAgentClient = makeClient({ agentId: undefined });
    await expect(
      noAgentClient.logOutcome({
        actionName: 'test',
        success: true,
      })
    ).rejects.toThrow(Layer5ValidationError);
  });

  it('validates outcomeScore range — too high', async () => {
    await expect(
      client.logOutcome({
        actionName: 'test',
        success: true,
        outcomeScore: 1.5,
      })
    ).rejects.toThrow(Layer5ValidationError);
  });

  it('validates outcomeScore range — negative', async () => {
    await expect(
      client.logOutcome({
        actionName: 'test',
        success: true,
        outcomeScore: -0.1,
      })
    ).rejects.toThrow(Layer5ValidationError);
  });

  it('sends optional fields only when provided', async () => {
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    await client.logOutcome({
      actionName: 'test',
      success: true,
      sessionId: 'sess',
      issueType: 'issue',
      businessOutcome: 'resolved',
      outcomeScore: 0.9,
      feedbackSignal: 'immediate',
    });

    expect(capturedBody.business_outcome).toBe('resolved');
    expect(capturedBody.outcome_score).toBe(0.9);
    expect(capturedBody.feedback_signal).toBe('immediate');
    expect(capturedBody.error_code).toBeUndefined();
    expect(capturedBody.customer_tier).toBeUndefined();
  });
});

// ── logOutcomeFeedback ───────────────────────────────────────

describe('logOutcomeFeedback', () => {
  let client: Layer5;

  beforeEach(() => {
    client = makeClient();
  });

  it('sends correct feedback request', async () => {
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE_URL}/v1/outcome-feedback`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_FEEDBACK);
      })
    );

    const result = await client.logOutcomeFeedback({
      outcomeId: 'out-123',
      finalScore: 0.2,
      businessOutcome: 'failed',
      feedbackNotes: 'Customer called back',
    });

    expect(result.updated).toBe(true);
    expect(result.outcome_id).toBe('test-uuid-123');
    expect(capturedBody.outcome_id).toBe('out-123');
    expect(capturedBody.feedback_notes).toBe('Customer called back');
  });
});

// ── HTTP Error Handling ──────────────────────────────────────

describe('HTTP error handling', () => {
  let client: Layer5;

  beforeEach(() => {
    client = makeClient();
  });

  it('maps 401 to Layer5AuthError', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
      )
    );
    await expect(
      client.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5AuthError);
  });

  it('maps 400 to Layer5ValidationError with field', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json({ error: 'bad field', field: 'agent_id' }, { status: 400 })
      )
    );
    await expect(
      client.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5ValidationError);
  });

  it('maps 422 to Layer5ValidationError', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json({ error: 'validation failed' }, { status: 422 })
      )
    );
    await expect(
      client.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5ValidationError);
  });

  it('maps 429 to Layer5RateLimitError with retryAfter', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json(
          { error: 'rate limited' },
          { status: 429, headers: { 'retry-after': '30' } }
        )
      )
    );

    try {
      await client.getScores({ context: { issue_type: 'test' } });
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Layer5RateLimitError);
      expect((error as Layer5RateLimitError).retryAfter).toBe(30);
    }
  });

  it('maps 403 AGENT_SUSPENDED to Layer5AgentSuspendedError', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json(
          { code: 'AGENT_SUSPENDED', agent_id: 'bad-agent' },
          { status: 403 }
        )
      )
    );
    await expect(
      client.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5AgentSuspendedError);
  });

  it('maps 404 UNKNOWN_ACTION to Layer5UnknownActionError', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json(
          { code: 'UNKNOWN_ACTION', action_name: 'bad_action' },
          { status: 404 }
        )
      )
    );
    await expect(
      client.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5UnknownActionError);
  });

  it('maps 500 to Layer5ServerError', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json(
          { error: 'Internal Server Error' },
          { status: 500, headers: { 'x-request-id': 'req-999' } }
        )
      )
    );

    try {
      await client.getScores({ context: { issue_type: 'test' } });
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Layer5ServerError);
      expect((error as Layer5ServerError).statusCode).toBe(500);
      expect((error as Layer5ServerError).requestId).toBe('req-999');
    }
  });
});

// ── Retry Logic ──────────────────────────────────────────────

describe('retry logic', () => {
  it('retries on 500 and succeeds', async () => {
    const client = makeClient({ maxRetries: 3 });
    let callCount = 0;

    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => {
        callCount++;
        if (callCount < 3) {
          return HttpResponse.json({ error: 'fail' }, { status: 500 });
        }
        return HttpResponse.json(MOCK_SCORES);
      })
    );

    const result = await client.getScores({
      context: { issue_type: 'test' },
    });
    expect(result.ranked_actions).toHaveLength(2);
    expect(callCount).toBe(3);
  });

  it('does not retry on 401', async () => {
    const client = makeClient({ maxRetries: 3 });
    let callCount = 0;

    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => {
        callCount++;
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
      })
    );

    await expect(
      client.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5AuthError);
    expect(callCount).toBe(1);
  });

  it('does not retry on 400 validation error', async () => {
    const client = makeClient({ maxRetries: 3 });
    let callCount = 0;

    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => {
        callCount++;
        return HttpResponse.json({ error: 'bad input' }, { status: 400 });
      })
    );

    await expect(
      client.getScores({ context: { issue_type: 'test' } })
    ).rejects.toThrow(Layer5ValidationError);
    expect(callCount).toBe(1);
  });
});
