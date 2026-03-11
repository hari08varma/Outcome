/**
 * Tests for wrapTools / wrapTool — Vercel AI SDK integration.
 */
import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Layer5 } from '../../src/client.js';
import { wrapTools, wrapTool } from '../../src/integrations/vercel-ai.js';
import { server, VALID_KEY, BASE_URL, MOCK_SCORES, MOCK_OUTCOME } from '../setup.js';

function makeClient(overrides: Record<string, unknown> = {}) {
  return new Layer5({
    apiKey: VALID_KEY,
    baseUrl: BASE_URL,
    agentId: 'vercel-agent',
    ...overrides,
  });
}

describe('wrapTools (Vercel AI)', () => {
  it('wrapTools wraps execute method', async () => {
    const client = makeClient();
    const executeFn = vi.fn().mockResolvedValue('found it');

    const tools = {
      search: {
        description: 'Search KB',
        parameters: {},
        execute: executeFn,
      },
    };

    const wrapped = wrapTools({ tools, client });
    const result = await wrapped.search.execute!();

    expect(result).toBe('found it');
    expect(executeFn).toHaveBeenCalled();
  });

  it('getScores called before execute', async () => {
    const callOrder: string[] = [];
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => {
        callOrder.push('getScores');
        return HttpResponse.json(MOCK_SCORES);
      }),
      http.post(`${BASE_URL}/v1/log-outcome`, () => {
        callOrder.push('logOutcome');
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    const client = makeClient();
    const tools = {
      search: {
        parameters: {},
        execute: vi.fn().mockImplementation(async () => {
          callOrder.push('execute');
          return 'done';
        }),
      },
    };

    const wrapped = wrapTools({ tools, client });
    await wrapped.search.execute!();

    expect(callOrder[0]).toBe('getScores');
    expect(callOrder[1]).toBe('execute');
  });

  it('logOutcome called with success=true after execute', async () => {
    let logBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => HttpResponse.json(MOCK_SCORES)),
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        logBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    const client = makeClient();
    const tools = {
      restart: {
        parameters: {},
        execute: vi.fn().mockResolvedValue({ status: 'ok' }),
      },
    };

    const wrapped = wrapTools({ tools, client });
    await wrapped.restart.execute!();

    // Wait for fire-and-forget logOutcome
    await new Promise(r => setTimeout(r, 100));

    expect(logBody).not.toBeNull();
    expect(logBody!.success).toBe(true);
    expect(logBody!.action_name).toBe('restart');
  });

  it('logOutcome called with success=false on throw', async () => {
    let logBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => HttpResponse.json(MOCK_SCORES)),
      http.post(`${BASE_URL}/v1/log-outcome`, async ({ request }) => {
        logBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(MOCK_OUTCOME, { status: 201 });
      })
    );

    const client = makeClient();
    const tools = {
      broken: {
        parameters: {},
        execute: vi.fn().mockRejectedValue(new Error('boom')),
      },
    };

    const wrapped = wrapTools({ tools, client });
    await expect(wrapped.broken.execute!()).rejects.toThrow('boom');

    await new Promise(r => setTimeout(r, 100));

    expect(logBody).not.toBeNull();
    expect(logBody!.success).toBe(false);
  });

  it('original error re-thrown after failure', async () => {
    const client = makeClient();
    const customError = new Error('custom error');
    const tools = {
      fail: {
        parameters: {},
        execute: vi.fn().mockRejectedValue(customError),
      },
    };

    const wrapped = wrapTools({ tools, client });
    await expect(wrapped.fail.execute!()).rejects.toThrow('custom error');
  });

  it('original return value preserved', async () => {
    const client = makeClient();
    const complexResult = { data: [1, 2, 3], meta: { page: 1 } };
    const tools = {
      query: {
        parameters: {},
        execute: vi.fn().mockResolvedValue(complexResult),
      },
    };

    const wrapped = wrapTools({ tools, client });
    const result = await wrapped.query.execute!();
    expect(result).toEqual(complexResult);
  });

  it('tool without execute passed through unchanged', () => {
    const client = makeClient();
    const noExecTool = { description: 'no execute', parameters: {} };
    const tools = { passive: noExecTool };

    const wrapped = wrapTools({ tools, client });
    expect(wrapped.passive).toBe(noExecTool);
  });

  it('Layer5 getScores error → tool still executes', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json({ error: 'down' }, { status: 500 })
      ),
      http.post(`${BASE_URL}/v1/log-outcome`, () =>
        HttpResponse.json(MOCK_OUTCOME, { status: 201 })
      )
    );

    const client = makeClient({ maxRetries: 1 });
    const executeFn = vi.fn().mockResolvedValue('still works');
    const tools = {
      resilient: {
        parameters: {},
        execute: executeFn,
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapped = wrapTools({ tools, client });
    const result = await wrapped.resilient.execute!();

    expect(result).toBe('still works');
    expect(executeFn).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('Layer5 logOutcome error → result still returned', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () => HttpResponse.json(MOCK_SCORES)),
      http.post(`${BASE_URL}/v1/log-outcome`, () =>
        HttpResponse.json({ error: 'fail' }, { status: 500 })
      )
    );

    const client = makeClient({ maxRetries: 1 });
    const tools = {
      search: {
        parameters: {},
        execute: vi.fn().mockResolvedValue('result'),
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapped = wrapTools({ tools, client });
    const result = await wrapped.search.execute!();

    expect(result).toBe('result');
    warnSpy.mockRestore();
  });

  it('silentErrors=false → Layer5 errors propagate', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, () =>
        HttpResponse.json({ error: 'down' }, { status: 500 })
      )
    );

    const client = makeClient({ maxRetries: 1 });
    const tools = {
      search: {
        parameters: {},
        execute: vi.fn().mockResolvedValue('ok'),
      },
    };

    const wrapped = wrapTools({ tools, client, silentErrors: false });
    await expect(wrapped.search.execute!()).rejects.toThrow();
  });

  it('wrapTool wraps single tool', async () => {
    const client = makeClient();
    const tool = {
      description: 'single tool',
      parameters: {},
      execute: vi.fn().mockResolvedValue('wrapped'),
    };

    const wrapped = wrapTool({
      toolName: 'single',
      tool,
      client,
    });

    const result = await wrapped.execute!();
    expect(result).toBe('wrapped');
  });

  it('context from tool params passed to getScores', async () => {
    let capturedUrl = '';
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(MOCK_SCORES);
      }),
      http.post(`${BASE_URL}/v1/log-outcome`, () =>
        HttpResponse.json(MOCK_OUTCOME, { status: 201 })
      )
    );

    const client = makeClient();
    const tools = {
      search: {
        parameters: {},
        execute: vi.fn().mockResolvedValue('ok'),
      },
    };

    const wrapped = wrapTools({ tools, client });
    await wrapped.search.execute!({ query: 'test' });

    const url = new URL(capturedUrl);
    // Context should include tool name
    const issueType = url.searchParams.get('issue_type');
    expect(issueType).toContain('search');
  });

  it('contextExtractor used when provided', async () => {
    let capturedUrl = '';
    server.use(
      http.get(`${BASE_URL}/v1/get-scores`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(MOCK_SCORES);
      }),
      http.post(`${BASE_URL}/v1/log-outcome`, () =>
        HttpResponse.json(MOCK_OUTCOME, { status: 201 })
      )
    );

    const client = makeClient();
    const tools = {
      search: {
        parameters: {},
        execute: vi.fn().mockResolvedValue('ok'),
      },
    };

    const wrapped = wrapTools({
      tools,
      client,
      contextExtractor: (toolName, _params) => ({
        issue_type: 'custom_' + toolName,
        custom: true,
      }),
    });
    await wrapped.search.execute!({ query: 'test' });

    const url = new URL(capturedUrl);
    expect(url.searchParams.get('issue_type')).toBe('custom_search');
  });
});
