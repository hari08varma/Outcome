/**
 * Tests for Layer5Callback — LangChain.js integration.
 */
import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Layer5Callback } from '../../src/integrations/langchain.js';
import { server, VALID_KEY, BASE_URL, MOCK_SCORES, MOCK_OUTCOME } from '../setup.js';

function makeCallback(overrides: Record<string, unknown> = {}) {
  return new Layer5Callback({
    apiKey: VALID_KEY,
    baseUrl: BASE_URL,
    agentId: 'lc-agent',
    ...overrides,
  });
}

describe('Layer5Callback (LangChain)', () => {
  it('creates callback with valid options', () => {
    const cb = makeCallback();
    expect(cb).toBeInstanceOf(Layer5Callback);
    expect(cb.name).toBe('Layer5Callback');
  });

  it('handleToolStart fetches scores', async () => {
    let captured = false;
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => {
        captured = true;
        return HttpResponse.json(MOCK_SCORES);
      })
    );

    const cb = makeCallback();
    await cb.handleToolStart({ name: 'search_kb' }, '{"query": "billing"}', 'run-1');

    expect(captured).toBe(true);
  });

  it('handleToolEnd logs successful outcome', async () => {
    let logBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => HttpResponse.json(MOCK_SCORES)),
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        logBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    const cb = makeCallback();
    await cb.handleToolStart({ name: 'search_kb' }, '{}', 'run-2');
    await cb.handleToolEnd('result text', 'run-2');

    expect(logBody).not.toBeNull();
    expect(logBody!.success).toBe(true);
    expect(logBody!.action_name).toBe('search_kb');
  });

  it('handleToolError logs failed outcome', async () => {
    let logBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => HttpResponse.json(MOCK_SCORES)),
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        logBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    const cb = makeCallback();
    await cb.handleToolStart({ name: 'broken_tool' }, '{}', 'run-3');
    await cb.handleToolError(new Error('tool failed'), 'run-3');

    expect(logBody).not.toBeNull();
    expect(logBody!.success).toBe(false);
    expect(logBody!.action_name).toBe('broken_tool');
  });

  it('handleToolEnd no-ops when runId not found', async () => {
    const cb = makeCallback();
    // Should not throw
    await cb.handleToolEnd('result', 'unknown-run');
  });

  it('handleToolError no-ops when runId not found', async () => {
    const cb = makeCallback();
    await cb.handleToolError(new Error('fail'), 'unknown-run');
  });

  it('silentErrors=true swallows Layer5 errors', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json({ error: 'down' }, { status: 500 })
      )
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cb = makeCallback({ silentErrors: true, maxRetries: 1 });

    await cb.handleToolStart({ name: 'test' }, '{}', 'run-4');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('silentErrors=false throws Layer5 errors', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json({ error: 'down' }, { status: 500 })
      )
    );

    const cb = makeCallback({ silentErrors: false, maxRetries: 1 });

    await expect(
      cb.handleToolStart({ name: 'test' }, '{}', 'run-5')
    ).rejects.toThrow();
  });

  it('contextExtractor used when provided', async () => {
    let capturedUrl = '';
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(MOCK_SCORES);
      })
    );

    const cb = makeCallback({
      contextExtractor: (toolName: string, _input: Record<string, unknown>) => ({
        issue_type: 'custom_type',
        tool_name: toolName,
      }),
    });

    await cb.handleToolStart({ name: 'test_tool' }, '{"q":"hi"}', 'run-6');

    const url = new URL(capturedUrl);
    expect(url.searchParams.get('issue_type')).toBe('custom_type');
  });

  it('parses invalid JSON input gracefully', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => HttpResponse.json(MOCK_SCORES))
    );

    const cb = makeCallback();
    // Not valid JSON — should not throw
    await cb.handleToolStart({ name: 'tool' }, 'not json', 'run-7');
  });

  it('uses _name param when tool.name is missing', async () => {
    let logBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => HttpResponse.json(MOCK_SCORES)),
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        logBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    const cb = makeCallback();
    await cb.handleToolStart({}, '{}', 'run-8', undefined, undefined, undefined, 'fallback_name');
    await cb.handleToolEnd('ok', 'run-8');

    expect(logBody!.action_name).toBe('fallback_name');
  });
});
