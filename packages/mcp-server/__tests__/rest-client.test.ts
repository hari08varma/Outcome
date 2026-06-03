import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpstreamMCPClient, LiApiClient } from '../src/rest-client.js';
import type { GatewayConfig, UpstreamServer } from '../src/config.js';
import { UpstreamRegistry } from '../src/upstream-registry.js';

function makeServer(overrides: Partial<UpstreamServer> = {}): UpstreamServer {
  return { name: 'github', url: 'https://github-mcp.test', ...overrides };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    apiKey: 'li-key', baseUrl: 'https://li.test', mode: 'recommend',
    upstreamServers: [makeServer()], modeOverrides: new Map(),
    shadowMode: false, environment: 'production', adminKey: null,
    logLevel: 'error', classifier: null, ...overrides,
  };
}

describe('UpstreamMCPClient', () => {
  let client: UpstreamMCPClient;
  let registry: UpstreamRegistry;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock global fetch
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    registry = new UpstreamRegistry(makeConfig());
    client = new UpstreamMCPClient(registry);
  });

  describe('initialize handshake', () => {
    it('sends initialize before tools/list', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2024-11-05', serverInfo: {}, capabilities: {} } }),
          { status: 200, headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'sess-1' } },
        ))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ));

      await client.listTools();

      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const initBody = JSON.parse(calls[0][1].body);
      expect(initBody.method).toBe('initialize');
    });

    it('coalesces concurrent init calls for same upstream', async () => {
      let resolveInit: (v: Response) => void;
      const initPromise = new Promise<Response>((r) => { resolveInit = r; });

      fetchMock
        .mockReturnValueOnce(initPromise)
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ));

      const p1 = client.listTools();
      const p2 = client.listTools();

      // Resolve init
      resolveInit!(new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2024-11-05', serverInfo: {}, capabilities: {} } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));

      await Promise.all([p1, p2]);

      // Only one initialize call should have been made
      const initCalls = fetchMock.mock.calls.filter(
        (c: [string, RequestInit]) => {
          try { return JSON.parse(c[1].body as string).method === 'initialize'; } catch { return false; }
        },
      );
      expect(initCalls.length).toBe(1);
    });

    it('caches session ID from initialize response', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }),
          { status: 200, headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'sess-abc' } },
        ))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ));

      await client.listTools();
      await client.callTool('github', 'push', {});

      // The tools/call request should have Mcp-Session-Id header
      const toolCallHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string> | undefined;
      expect(toolCallHeaders?.['Mcp-Session-Id']).toBe('sess-abc');
    });
  });

  describe('callTool', () => {
    beforeEach(() => {
      fetchMock
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2024-11-05', capabilities: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        .mockResolvedValueOnce(new Response('', { status: 200 }));
    });

    it('sends correct JSON-RPC body', async () => {
      fetchMock.mockResolvedValueOnce(new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));

      await client.callTool('github', 'push', { branch: 'main' });

      const callBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
      expect(callBody.method).toBe('tools/call');
      expect(callBody.params.name).toBe('push');
      expect(callBody.params.arguments).toEqual({ branch: 'main' });
    });

    it('throws on unknown upstream', async () => {
      await expect(client.callTool('nonexistent', 'tool', {})).rejects.toThrow('not found');
    });

    it('records upstream failure on error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(client.callTool('github', 'tool', {})).rejects.toThrow();
      expect(registry.getFailOpenState().upstreamFailures.get('github')).toBe(1);
    });
  });

  describe('concurrency gate', () => {
    it('throws when max concurrent is reached', async () => {
      // Override max concurrent for test
      process.env.LAYERINFINITE_MAX_UPSTREAM_CONCURRENT = '1';
      const c = new UpstreamMCPClient(registry);
      delete process.env.LAYERINFINITE_MAX_UPSTREAM_CONCURRENT;

      // Simulate init already done + one connection active
      (c as unknown as { initialized: Map<string, boolean> }).initialized.set('github', true);
      (c as unknown as { activeConnections: Map<string, number> }).activeConnections.set('github', 1);

      await expect(c.callTool('github', 'tool', {})).rejects.toThrow('concurrency limit');
    });
  });
});

describe('LiApiClient key rotation', () => {
  let liApi: LiApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('retries with secondary key on 401', async () => {
    const config = makeConfig({ apiKey: 'primary-key', apiKeySecondary: 'fallback-key' });
    liApi = new LiApiClient(config);

    fetchMock
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ scores: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));

    const scores = await liApi.getScores('build_failed', 'cust-1', 'agent-1');

    expect(scores).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(secondCallHeaders['X-API-Key']).toBe('fallback-key');
  });

  it('retries with secondary key on 403', async () => {
    const config = makeConfig({ apiKey: 'primary', apiKeySecondary: 'fallback' });
    liApi = new LiApiClient(config);

    fetchMock
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Forbidden' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ scores: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));

    await liApi.getScores('test', 'c', 'a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry without secondary key', async () => {
    const config = makeConfig({ apiKey: 'primary' }); // no secondary
    liApi = new LiApiClient(config);

    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));

    const result = await liApi.getScores('test', 'c', 'a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // getScores returns empty array on failure
    expect(result).toEqual([]);
  });

  it('uses primary key on first attempt', async () => {
    const config = makeConfig({ apiKey: 'primary-key' });
    liApi = new LiApiClient(config);

    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ scores: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await liApi.getScores('test', 'c', 'a');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('primary-key');
  });
});
